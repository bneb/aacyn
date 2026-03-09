import { Elysia } from "elysia";
import * as crypto from "node:crypto";
import { healthRoutes } from "./routes/health";
import { eventsRoutes } from "./routes/events";
import { queryRoutes } from "./routes/query";
import { ingestRoutes } from "./routes/ingest";
import { traceRoutes } from "./routes/trace";
import { otlpRoutes } from "./routes/otlp";
import { discoveryRoutes } from "./routes/discovery";
import { dashboardRoutes } from "./routes/dashboard";
import { alertRoutes, setAlertEngine } from "./routes/alerts";
import { sloRoutes, sloEngine } from "./routes/slo";
import { DEFAULT_SLOS } from "./lib/slo";
import { metrics } from "./lib/metrics";
import { requireRateLimit } from "./lib/rate-limiter";
import { Aggregator, NodePushClient } from "./lib/aggregator";
import { forwarders } from "./lib/forwarder";
import { DatadogForwarder } from "./lib/forwarders/datadog";
import { SplunkForwarder } from "./lib/forwarders/splunk";
import { OtlpForwarder } from "./lib/forwarders/otlp";
import { createLogger, requestContext } from "./lib/logger";
import type { TopologyEdge, DiscoveredService } from "@aacyn/sdk";
import type { AlertOutput } from "./lib/alerting";
import type { NodeTopology } from "./lib/aggregator";
const log = createLogger("server");



function generateRequestId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}


// ─── Auth helpers: Bearer token extraction, verification ───────────────────

/** Extract Bearer token from the Authorization header. Returns null on invalid format. */
function extractBearerToken(authHeader: string, set: { status?: number | string }): string | null {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        set.status = 401;
        return null;
    }
    return match[1];
}

/** Timing-safe comparison of the bearer token against the configured API key. */
function verifyApiKey(token: string, set: { status?: number | string }): boolean {
    const apiKey = process.env.AACYN_API_KEY!;
    const tokenBuf = Buffer.from(token);
    const keyBuf = Buffer.from(apiKey);
    if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
        set.status = 401;
        return false;
    }
    return true;
}


import { initializeStore } from "./lib/store-init";
import { K8sDiscovery } from "./lib/k8s-discovery";
const store = await initializeStore();
const k8sDiscovery = new K8sDiscovery();
k8sDiscovery.start().catch((err: Error) => {
    log.warn("K8s pod enrichment unavailable: " + err.message);
});

let aggregator: Aggregator | undefined;

export const app = new Elysia({
    serve: {
        maxRequestBodySize: 10 * 1024 * 1024, // 10MB max body size
    },
})
    // ── Rate limiting on all routes ───────────────────────────────────
    .onRequest(({ set, request }) => {
        const result = requireRateLimit({ set, request });
        if (result) return result;
    })
    // ── Request ID ──────────────────────────────────────────────────────
    .derive(() => {
        const requestId = requestContext.getStore() || generateRequestId();
        const startTime = Date.now();
        return { requestId, startTime };
    })
    .onAfterHandle(({ set, requestId }) => {
        set.headers["X-Request-Id"] = requestId;
    })
    .decorate("store", store)
    .decorate("k8sDiscovery", k8sDiscovery)
    .onAfterResponse(({ request, route, set, startTime }) => {
        const durationMs = Date.now() - startTime;
        const method = request.method;
        const path = route || new URL(request.url).pathname;
        const status = set.status ? set.status.toString() : "unknown";

        metrics.count("http_requests_total", 1, { method, path, status });
        metrics.duration("http_request_duration_ms", durationMs, { method, path, status });

        const sizeBytes = Number(request.headers.get("content-length") || 0);
        if (sizeBytes > 0) {
            metrics.count("http_request_size_bytes_sum", sizeBytes, { method, path, status });
        }
    })
    // ── Public routes ────────────────────────────────────────────────────
    .use(healthRoutes)
    .get("/v1/metrics", ({ set }) => {
        set.headers["Content-Type"] = "text/plain; version=0.0.4";
        return metrics.prometheusText();
    })
    // ── Authenticated routes ──────────────────────────────────────────────
    .guard(
        {
            beforeHandle({ set, headers, request }) {
                const apiKey = process.env.AACYN_API_KEY;
                if (!apiKey) {
                    if (process.env.NODE_ENV === "production") {
                        log.error("FATAL: AACYN_API_KEY is required in production. Set it to a random string (>=32 chars).");
                        set.status = 500;
                        return { error: "Server misconfigured: AACYN_API_KEY is not set. Set AACYN_API_KEY in your environment or .env file to a random string of 32+ characters." };
                    }
                    return; // Auth disabled — allow all in development
                }

                const authHeader = headers["authorization"];
                if (!authHeader) {
                    set.status = 401;
                    return { error: "Missing Authorization header. Include: Authorization: Bearer <your-api-key>" };
                }

                const token = extractBearerToken(authHeader, set);
                if (!token) return { error: "Invalid Authorization format. Use: Authorization: Bearer <key>" };

                if (!verifyApiKey(token, set)) return { error: "Invalid API key. Check your AACYN_API_KEY environment variable matches the Bearer token you are sending." };

            },
        },
        (app) =>
            app
                .use(eventsRoutes)
                .use(queryRoutes)
                .use(ingestRoutes)
                .use(traceRoutes)
                .use(otlpRoutes)
                .use(discoveryRoutes)
                .use(dashboardRoutes)
                .use(alertRoutes)
                .use(sloRoutes)
                .post("/v1/aggregator/push", async ({ body, set }) => {
                    if (!aggregator) {
                        set.status = 503;
                        return { error: "Aggregator not initialized" };
                    }
                    const payload = body as Record<string, unknown>;
                    const nodeId = String(payload.nodeId || "");
                    const edges = (payload.edges as NodeTopology["edges"]) || [];
                    const services = (payload.services as NodeTopology["services"]) || [];
                    const goldenSignals = (payload.goldenSignals as NodeTopology["goldenSignals"]) || [];
                    const ebpfDrops = (payload.ebpfDrops as NodeTopology["ebpfDrops"]) || { standard: 0, critical: 0 };
                    const merged = aggregator.push(nodeId, {
                        nodeId, edges, services, goldenSignals, ebpfDrops,
                        timestamp: Number(payload.timestamp) || Date.now(),
                    });
                    return { merged: { nodeCount: merged.nodeCount, edgeCount: merged.edges.length, serviceCount: merged.services.length } };
                })
                .get("/v1/aggregator/topology", () =>
                    aggregator ? aggregator.getMerged() : { error: "Aggregator not initialized" }
                )
    );

// ─── Aggregator & Node Client Startup ─────────────────────────────────────

const mode = process.env.AACYN_MODE || "standalone";
const aggregatorUrl = process.env.AACYN_AGGREGATOR_URL;

if (mode === "aggregator" || mode === "full") {
    aggregator = new Aggregator();
    log.info(`[Aggregator] Running in ${mode} mode — accepting node topology pushes`);
    // Aggregator push & topology endpoints are registered inside the authenticated guard above
}

/** Build a full topology snapshot from the local store for node push. */
function buildTopologySnapshot(): NodeTopology {
    const edges = store.topologyEdges();
    const services = store.discoveredServices();
    const drops = store.dropCounts();
    return {
        nodeId: "",
        edges: edges.map((e: TopologyEdge) => ({
            source: e.source,
            target: e.target,
            sourceIp: e.sourceIp || "0.0.0.0",
            destIp: e.destIp || "0.0.0.0",
            destPort: e.destPort || 0,
            hitCount: e.hitCount || 0,
            avgLatencyUs: e.avgLatencyUs || 0,
            totalBytes: e.totalBytes || 0,
            errorCount: e.errorCount || 0,
        })),
        services: services.map((s: DiscoveredService) => ({
            pid: s.pid || 0,
            port: s.port || 0,
            comm: s.comm || "",
            acceptCount: s.acceptCount || 0,
            avgLatencyMs: s.avgLatencyMs || 0,
        })),
        goldenSignals: [],
        ebpfDrops: drops,
        timestamp: Date.now(),
    };
}

// Node push client: when running in node mode with an aggregator URL
if ((mode === "node" || mode === "full") && aggregatorUrl) {
    const nodeClient = new NodePushClient({ aggregatorUrl });
    log.info(`[Aggregator] Node client pushing to ${aggregatorUrl}`);

    // Start pushing topology data on an interval
    nodeClient.start(() => {
        try {
            return buildTopologySnapshot();
        } catch (err) {
            log.warn("[Topology] Store query failed: " + (err as Error).message);
            return {
                nodeId: "",
                edges: [],
                services: [],
                goldenSignals: [],
                ebpfDrops: { standard: 0, critical: 0 },
                timestamp: Date.now(),
            };
        }
    });
}

// ─── Startup Forwarders ──────────────────────────────────────────────────────
const ddApiKey = process.env.DATADOG_API_KEY;
if (ddApiKey) {
    const ddSite = process.env.DATADOG_SITE || "datadoghq.com";
    const dd = new DatadogForwarder({ apiKey: ddApiKey, site: ddSite });
    forwarders.register(dd);
    log.info(`[Forwarder] Datadog → api.${ddSite} (metrics v2)`);
}

const splunkHecUrl = process.env.SPLUNK_HEC_URL;
const splunkHecToken = process.env.SPLUNK_HEC_TOKEN;
if (splunkHecUrl && splunkHecToken) {
    const splunk = new SplunkForwarder({ hecUrl: splunkHecUrl, hecToken: splunkHecToken });
    forwarders.register(splunk);
    log.info(`[Forwarder] Splunk → ${new URL(splunkHecUrl).hostname}`);
}

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (otlpEndpoint) {
    const otlpHeaders = OtlpForwarder.parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
    const otlp = new OtlpForwarder({ endpoint: otlpEndpoint, headers: otlpHeaders });
    forwarders.register(otlp);
    log.info(`[Forwarder] OTLP → ${otlpEndpoint}/v1/traces`);
}

// ─── Trace Span Drain Polling ────────────────────────────────────────────────
// Poll the C trace span buffer every 5 seconds and add new spans to the index.
// On macOS (no eBPF), drainTraceSpans returns 0 and this is a no-op.
const traceDrainTimer = setInterval(() => {
    try {
        const drained = store.drainTraceSpans();
        if (drained > 0) {
            log.info(`[Tracing] Drained ${drained} trace spans from eBPF buffer`);
        }
    } catch (err) {
        log.warn("[Tracing] Trace span drain failed: " + (err as Error).message);
    }
}, 5000);


function printBanner() {
    log.info(`
┌──────────────────────────────────────────────────┐
│  aacyn v1.0.0-dev — Apache 2.0                  │
└──────────────────────────────────────────────────┘`);
}

printBanner();

// ─── Alerting Engine Startup ─────────────────────────────────────────────────
const { AlertEngine, DEFAULT_ALERT_RULES, StdoutAlertOutput, WebhookAlertOutput, SlackWebhookAlertOutput } = await import("./lib/alerting");

/** Compute golden signals (RPS, error rate, latency, throughput) from topology edges. */
function computeGoldenSignals(edges: TopologyEdge[]): Array<{
    service: string;
    rate_rps: number;
    error_pct: number;
    avg_latency_ms: number;
    throughput_kbps: number;
}> {
    const uptime = Math.max(1, process.uptime() * 1000);
    const byTarget = new Map<string, { hits: number; errors: number; latencyUs: number; bytes: number }>();
    for (const e of edges) {
        const existing = byTarget.get(e.target) || { hits: 0, errors: 0, latencyUs: 0, bytes: 0 };
        existing.hits += e.hitCount;
        existing.errors += e.errorCount;
        existing.latencyUs += e.avgLatencyUs * e.hitCount;
        existing.bytes += e.totalBytes;
        byTarget.set(e.target, existing);
    }

    return Array.from(byTarget.entries()).map(([service, data]) => ({
        service,
        rate_rps: data.hits / uptime,
        error_pct: (data.hits + data.errors) > 0 ? (data.errors / (data.hits + data.errors)) * 100 : 0,
        avg_latency_ms: data.hits > 0 ? (data.latencyUs / data.hits) / 1000 : 0,
        throughput_kbps: (data.bytes / uptime) / 1024,
    }));
}

/** Fetch topology data and compute alert inputs from the local store. Returns null on error. */
function buildAlertTopologySnapshot() {
    try {
        const edges = store.topologyEdges();
        const drops = store.dropCounts();
        const golden_signals = computeGoldenSignals(edges);

        const snapshot = {
            edges: edges.map((e: TopologyEdge) => ({
                target: e.target,
                hit_count: e.hitCount,
                latency_us: e.avgLatencyUs,
                bytes_transferred: e.totalBytes,
                error_count: e.errorCount,
            })),
            golden_signals,
            drops,
        };
        recordSloMetrics(snapshot);
        return snapshot;
    } catch (err) {
        log.error("[Topology] Store query failed:" + " " + String(err));
        return null;
    }
}

// ─── SLO Initialization ──────────────────────────────────────────────
sloEngine.define(DEFAULT_SLOS);

/** Record golden signal data into the SLO engine for error budget tracking. */
function recordSloMetrics(snapshot: { golden_signals: { service: string; avg_latency_ms: number; error_pct: number; throughput_kbps: number }[] } | null) {
    if (!snapshot) return;
    for (const sig of snapshot.golden_signals) {
        sloEngine.record(sig.service, "latency", sig.avg_latency_ms);
        sloEngine.record(sig.service, "error_rate", sig.error_pct);
        sloEngine.record(sig.service, "throughput", sig.throughput_kbps);
    }
}

const alertOutputs: AlertOutput[] = [new StdoutAlertOutput()];
const webhookUrl = process.env.ALERT_WEBHOOK_URL;
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
if (webhookUrl) {
    alertOutputs.push(new WebhookAlertOutput(webhookUrl));
}
if (slackWebhookUrl) {
    alertOutputs.push(new SlackWebhookAlertOutput(slackWebhookUrl));
    log.info(`[Alerting] Slack webhook configured`);
}

const alertEngine = new AlertEngine({
    rules: DEFAULT_ALERT_RULES,
    outputs: alertOutputs,
});

setAlertEngine(alertEngine);

// Start alert evaluation against topology data
alertEngine.start(() => buildAlertTopologySnapshot(), 30_000);

const originalHandle = app.handle.bind(app);
app.handle = async (req: Request) => {
    const reqId = req.headers.get("X-Request-Id") || generateRequestId();
    return requestContext.run(reqId, () => originalHandle(req));
};

process.on("SIGTERM", () => {
    clearInterval(traceDrainTimer);
    alertEngine.stop();
    forwarders.shutdownAll().then(() => process.exit(0));
});
