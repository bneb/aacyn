/**
 * OTLP Forwarder — Ships aacyn telemetry to any OpenTelemetry Collector via
 * the OTLP HTTP protobuf protocol (ExportTraceServiceRequest).
 *
 * Transforms RED metrics and topology edges into OTLP spans grouped under a
 * common "aacyn" resource. Each metric becomes a span with attribute details;
 * each edge becomes a client span representing the connection.
 *
 * Configured via environment:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com:4318
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer+token123,foo=bar   (optional, comma-separated, space encoded as +)
 *
 * The exporter appends /v1/traces to the endpoint.
 */

import type { Forwarder, ForwardBatch } from "../forwarder";
import { metrics } from "../metrics";
import { createLogger } from "../logger";
import { createRequire } from "node:module";
const log = createLogger("lib-forwarders-otlp");
const require = createRequire(import.meta.url);

// Load the OTLP protobuf static codegen
const $root = require("@opentelemetry/otlp-transformer/build/src/generated/root") as {
    opentelemetry: {
        proto: {
            common: {
                v1: {
                    KeyValue: ProtobufType;
                    AnyValue: ProtobufType;
                    InstrumentationScope: ProtobufType;
                };
            };
            resource: {
                v1: {
                    Resource: ProtobufType;
                };
            };
            collector: {
                trace: {
                    v1: {
                        ExportTraceServiceRequest: ProtobufType;
                        ExportTraceServiceResponse: ProtobufType;
                    };
                };
            };
        };
    };
};

interface ProtobufType {
    create(props: Record<string, unknown>): Record<string, unknown>;
    encode(msg: Record<string, unknown>, writer?: unknown): { finish(): Uint8Array };
}

interface OtlpConfig {
    endpoint: string;
    headers?: Record<string, string>;
    maxRps?: number;
}

interface OtlpHeaders {
    [key: string]: string;
}

function parseHeaders(raw: string | undefined): OtlpHeaders {
    const headers: OtlpHeaders = {};
    if (!raw) return headers;
    for (const part of raw.split(",")) {
        const eqIdx = part.indexOf("=");
        if (eqIdx === -1) continue;
        const key = part.slice(0, eqIdx).trim();
        const val = part.slice(eqIdx + 1).trim().replace(/\+/g, " ");
        if (key) headers[key] = val;
    }
    return headers;
}

export class OtlpForwarder implements Forwarder {
    readonly name = "otlp";
    private endpoint: string;
    private headers: OtlpHeaders;
    private maxRps: number;
    private lastRequestTime = 0;

    constructor(config: OtlpConfig) {
        this.endpoint = config.endpoint.replace(/\/+$/, "") + "/v1/traces";
        this.headers = { ...config.headers };
        this.maxRps = config.maxRps || 100;
    }

    async send(batch: ForwardBatch): Promise<{ accepted: number; rejected: number }> {
        if (batch.metrics.length === 0 && batch.edges.length === 0) {
            return { accepted: 0, rejected: 0 };
        }
        const request = this.buildExportRequest(batch);
        const payload = this.encodeRequest(request);
        return this.postPayload(payload);
    }

    async healthCheck(): Promise<boolean> {
        try {
            const healthUrl = this.endpoint.replace(/\/v1\/traces\/?$/, "");
            const res = await fetch(healthUrl, {
                method: "GET",
                headers: {
                    "User-Agent": "aacyn-forwarder/1.0",
                    ...this.headers,
                },
                signal: AbortSignal.timeout(5_000),
            });
            return res.ok;
        } catch (err) {
            log.error("[OTLP] Health check failed: " + String(err));
            return false;
        }
    }

    async shutdown(): Promise<void> {
        // No persistent buffers
    }

    // ── Request Building ──────────────────────────────────────────────

    private buildExportRequest(batch: ForwardBatch): Record<string, unknown> {
        const resourceSpans: Record<string, unknown>[] = [];

        // One ResourceSpans per batch — all spans share the aacyn resource
        const spans: Record<string, unknown>[] = [];
        for (const metric of batch.metrics) {
            spans.push(this.metricToSpan(metric));
        }
        for (const edge of batch.edges) {
            spans.push(this.edgeToSpan(edge));
        }

        if (spans.length === 0) {
            return { resourceSpans: [] };
        }

        resourceSpans.push({
            resource: {
                attributes: [
                    this.kv("service.name", "aacyn"),
                    this.kv("telemetry.sdk.name", "aacyn"),
                    this.kv("telemetry.sdk.language", "rust"),
                    this.kv("telemetry.sdk.version", "1.0.0-dev"),
                ],
                droppedAttributesCount: 0,
            },
            scopeSpans: [
                {
                    scope: { name: "aacyn.forwarder", version: "1.0.0" },
                    spans,
                },
            ],
        });

        return { resourceSpans };
    }

    private metricToSpan(
        metric: ForwardBatch["metrics"][number],
    ): Record<string, unknown> {
        const nowNs = BigInt(metric.timestamp) * 1_000_000_000n;
        return {
            traceId: this.serviceTraceId(metric.service),
            spanId: this.randomSpanId(),
            name: `service.${metric.service}`,
            kind: 1, // SPAN_KIND_INTERNAL
            startTimeUnixNano: String(nowNs),
            endTimeUnixNano: String(nowNs + 1_000_000_000n),
            attributes: [
                this.kv("aacyn.service.name", metric.service),
                this.kv("aacyn.service.rate", metric.rate),
                this.kv("aacyn.service.error_rate", metric.errorRate),
                this.kv("aacyn.service.latency.p50_ms", metric.p50Ms),
                this.kv("aacyn.service.latency.p95_ms", metric.p95Ms),
                this.kv("aacyn.service.latency.p99_ms", metric.p99Ms),
                this.kv("aacyn.service.throughput_kbps", metric.throughputKbps),
            ],
            droppedAttributesCount: 0,
            events: [],
            droppedEventsCount: 0,
            links: [],
            droppedLinksCount: 0,
            status: { code: 0 }, // STATUS_CODE_UNSET
            flags: 0,
        };
    }

    private edgeToSpan(
        edge: ForwardBatch["edges"][number],
    ): Record<string, unknown> {
        const nowNs = BigInt(edge.timestamp) * 1_000_000_000n;
        return {
            traceId: this.edgeTraceId(edge.source, edge.target),
            spanId: this.randomSpanId(),
            name: `connection.${edge.source}.${edge.target}`,
            kind: 3, // SPAN_KIND_CLIENT
            startTimeUnixNano: String(nowNs),
            endTimeUnixNano: String(nowNs + 1_000_000_000n),
            attributes: [
                this.kv("aacyn.edge.source", edge.source),
                this.kv("aacyn.edge.target", edge.target),
                this.kv("aacyn.edge.hit_count", edge.hitCount),
                this.kv("aacyn.edge.avg_latency_us", edge.avgLatencyUs),
                this.kv("aacyn.edge.error_count", edge.errorCount),
                this.kv("aacyn.edge.total_bytes", edge.totalBytes),
            ],
            droppedAttributesCount: 0,
            events: [],
            droppedEventsCount: 0,
            links: [],
            droppedLinksCount: 0,
            status: { code: edge.errorCount > 0 ? 2 : 0 }, // STATUS_CODE_ERROR or STATUS_CODE_UNSET
            flags: 0,
        };
    }

    private encodeRequest(request: Record<string, unknown>): Uint8Array | null {
        const type = $root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
        try {
            const msg = type.create(request);
            return type.encode(msg).finish();
        } catch (err) {
            log.error("[OTLP] Encoding failed: " + String(err));
            return null;
        }
    }

    // ── HTTP Transport ──────────────────────────────────────────────────

    private async postPayload(
        payload: Uint8Array | null,
    ): Promise<{ accepted: number; rejected: number }> {
        if (!payload) return { accepted: 0, rejected: 0 };

        // Copy protobuf bytes into a plain Uint8Array for fetch body compatibility
        const body = payload.slice(0);

        await this.throttle();

        try {
            const res = await fetch(this.endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-protobuf",
                    "User-Agent": "aacyn-forwarder/1.0",
                    ...this.headers,
                },
                body: body,
                signal: AbortSignal.timeout(30_000),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                log.error(`[OTLP] Endpoint returned ${res.status}: ${body.slice(0, 200)}`);
                metrics.count("aacyn_forwarder_otlp_errors", 1, { endpoint: "traces" });
                return { accepted: 0, rejected: 1 };
            }

            return { accepted: 1, rejected: 0 };
        } catch (err) {
            log.error("[OTLP] Endpoint unreachable: " + (err instanceof Error ? err.message : String(err)));
            metrics.count("aacyn_forwarder_otlp_errors", 1, { endpoint: "traces" });
            return { accepted: 0, rejected: 1 };
        }
    }

    // ── Rate Limiting ───────────────────────────────────────────────────

    private async throttle(): Promise<void> {
        const now = Date.now();
        const minInterval = 1000 / this.maxRps;
        const elapsed = now - this.lastRequestTime;
        if (elapsed < minInterval) {
            await new Promise(r => setTimeout(r, minInterval - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /** Deterministic 16-byte trace ID from a service name. */
    private serviceTraceId(service: string): string {
        const hash = this.simpleHash(service);
        return `${hash}${hash}`.slice(0, 32);
    }

    /** Deterministic 16-byte trace ID from an edge. */
    private edgeTraceId(source: string, target: string): string {
        const hash = this.simpleHash(`${source}:${target}`);
        return `${hash}${hash}`.slice(0, 32);
    }

    /** Random 16-hex-char (8-byte) span ID. */
    private randomSpanId(): string {
        return Math.random().toString(16).slice(2, 18).padEnd(16, "0");
    }

    /** Simple 16-hex-char hash (not cryptographic). */
    private simpleHash(input: string): string {
        let h = 0;
        for (let i = 0; i < input.length; i++) {
            h = ((h << 5) - h + input.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(16).padStart(16, "0");
    }

    private kv(key: string, value: string | number): Record<string, unknown> {
        const anyVal: Record<string, unknown> = {};
        if (typeof value === "number") {
            if (Number.isInteger(value)) {
                anyVal.intValue = value;
            } else {
                anyVal.doubleValue = value;
            }
        } else {
            anyVal.stringValue = value;
        }
        return { key, value: anyVal };
    }

    /** Parse OTEL_EXPORTER_OTLP_HEADERS format into a headers object. */
    static parseHeaders(raw: string | undefined): OtlpHeaders {
        return parseHeaders(raw);
    }
}
