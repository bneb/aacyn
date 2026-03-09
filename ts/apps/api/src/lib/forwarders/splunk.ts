/**
 * Splunk Forwarder — Ships aacyn telemetry to Splunk via HTTP Event Collector.
 *
 * Transforms RED metrics and topology edges into Splunk events. Uses the
 * HEC JSON endpoint with client-side throttling and chunked batching.
 *
 * Configured via environment:
 *   SPLUNK_HEC_URL=https://splunk.example.com:8088/services/collector/event
 *   SPLUNK_HEC_TOKEN=<your-hec-token>
 */

import type { Forwarder, ForwardBatch } from "../forwarder";
import { metrics } from "../metrics";
import { createLogger } from "../logger";
const log = createLogger("lib-forwarders-splunk");

export interface SplunkConfig {
    hecUrl: string;
    hecToken: string;
    /** Max requests per second (Splunk HEC default is generous; cap at 100) */
    maxRps?: number;
    /** Splunk index to write to (default: "main") */
    index?: string;
}

interface SplunkEvent {
    time: number;
    host: string;
    source: string;
    sourcetype: string;
    index: string;
    event: Record<string, unknown>;
}

export class SplunkForwarder implements Forwarder {
    readonly name = "splunk";
    private hecUrl: string;
    private hecToken: string;
    private maxRps: number;
    private index: string;
    private lastRequestTime = 0;

    constructor(config: SplunkConfig) {
        this.hecUrl = config.hecUrl.replace(/\/+$/, ""); // strip trailing slashes
        this.hecToken = config.hecToken;
        this.maxRps = config.maxRps || 100;
        this.index = config.index || "main";
        log.info(`[Splunk] Forwarder configured — ${this.hecUrl}`);
    }

    async send(batch: ForwardBatch): Promise<{ accepted: number; rejected: number }> {
        const events = [
            ...this.transformMetrics(batch),
            ...this.transformEdges(batch),
        ];

        if (events.length === 0) return { accepted: 0, rejected: 0 };

        // Splunk HEC accepts up to ~1MB per request. Split into chunks of 500.
        const CHUNK_SIZE = 500;
        let accepted = 0;
        let rejected = 0;

        for (let i = 0; i < events.length; i += CHUNK_SIZE) {
            const chunk = events.slice(i, i + CHUNK_SIZE);
            const result = await this.sendChunk(chunk);
            accepted += result.accepted;
            rejected += result.rejected;
        }

        return { accepted, rejected };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const healthUrl = this.hecUrl.replace(/\/event\/?$/, "/health");
            const res = await fetch(healthUrl, {
                method: "GET",
                headers: {
                    Authorization: `Splunk ${this.hecToken}`,
                    "User-Agent": "aacyn-forwarder/1.0",
                },
                signal: AbortSignal.timeout(5_000),
            });
            return res.ok;
        } catch (err) {
            log.error("[Splunk] Health check failed: " + String(err));
            return false;
        }
    }

    async shutdown(): Promise<void> {
        // No persistent buffers — events are sent immediately.
    }

    // ── Transformation ─────────────────────────────────────────────────

    private baseFields(): Pick<SplunkEvent, "host" | "source" | "sourcetype" | "index"> {
        return {
            host: "aacyn",
            source: "aacyn",
            sourcetype: "aacyn:metrics",
            index: this.index,
        };
    }

    private transformMetrics(batch: ForwardBatch): SplunkEvent[] {
        const base = this.baseFields();
        return batch.metrics.map(m => ({
            ...base,
            time: m.timestamp,
            sourcetype: "aacyn:metrics",
            event: {
                type: "metric",
                service: m.service,
                rate_rps: m.rate,
                error_rate_pct: m.errorRate,
                latency_p50_ms: m.p50Ms,
                latency_p95_ms: m.p95Ms,
                latency_p99_ms: m.p99Ms,
                throughput_kbps: m.throughputKbps,
            },
        }));
    }

    private transformEdges(batch: ForwardBatch): SplunkEvent[] {
        const base = this.baseFields();
        return batch.edges.map(e => ({
            ...base,
            time: e.timestamp,
            sourcetype: "aacyn:topology",
            event: {
                type: "topology_edge",
                source: e.source,
                target: e.target,
                hit_count: e.hitCount,
                avg_latency_us: e.avgLatencyUs,
                error_count: e.errorCount,
                total_bytes: e.totalBytes,
            },
        }));
    }

    // ── HTTP Transport ──────────────────────────────────────────────────

    private async sendChunk(events: SplunkEvent[]): Promise<{ accepted: number; rejected: number }> {
        await this.throttle();

        try {
            const res = await fetch(this.hecUrl, {
                method: "POST",
                headers: {
                    Authorization: `Splunk ${this.hecToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": "aacyn-forwarder/1.0",
                },
                body: JSON.stringify(events),
                signal: AbortSignal.timeout(30_000),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                log.error(`[Splunk] HEC returned ${res.status}: ${body.slice(0, 200)}`);
                metrics.count("aacyn_forwarder_splunk_errors", 1, { endpoint: "hec" });
                return { accepted: 0, rejected: events.length };
            }

            const result = await res.json() as { code?: number; text?: string };
            if (result.code !== 0) {
                log.warn(`[Splunk] HEC partial failure: ${result.text || "unknown"}`);
                metrics.count("aacyn_forwarder_splunk_errors", 1, { endpoint: "hec" });
                return { accepted: 0, rejected: events.length };
            }

            return { accepted: events.length, rejected: 0 };
        } catch (err) {
            log.error("[Splunk] HEC unreachable: " + (err instanceof Error ? err.message : String(err)));
            metrics.count("aacyn_forwarder_splunk_errors", 1, { endpoint: "hec" });
            return { accepted: 0, rejected: events.length };
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
}
