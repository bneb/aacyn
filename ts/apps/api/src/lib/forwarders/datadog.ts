/**
 * Datadog Forwarder — Ships filtered aacyn telemetry to Datadog Metrics API v2.
 *
 * Transforms RED metrics into Datadog metric series and topology edges
 * into Datadog events. Respects Datadog rate limits with client-side throttling.
 *
 * Configured via aacyn.toml:
 *   [forward.datadog]
 *   enabled = true
 *   apiKey = "${DATADOG_API_KEY}"
 *   site = "datadoghq.com"
 *
 * Usage:
 *   import { DatadogForwarder } from "./forwarders/datadog";
 *   const dd = new DatadogForwarder({ apiKey: "...", site: "datadoghq.com" });
 *   await dd.send(batch);
 */

import type { Forwarder, ForwardBatch } from "../forwarder";
import { metrics } from "../metrics";
import { createLogger } from "../logger";
const log = createLogger("lib-forwarders-datadog");



export interface DatadogConfig {
    apiKey: string;
    site?: string; // "datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", etc.
    /** Max requests per second (Datadog default: ~100/s for metrics API) */
    maxRps?: number;
}

interface DatadogSeries {
    metric: string;
    type: 0 | 1 | 2 | 3; // 0=unspecified, 1=count, 2=rate, 3=gauge
    points: { timestamp: number; value: number }[];
    tags: string[];
    unit?: string;
}

interface DatadogEvent {
    title: string;
    text: string;
    alert_type: "info" | "warning" | "error";
    tags: string[];
    timestamp: number;
}

export class DatadogForwarder implements Forwarder {
    readonly name = "datadog";
    private apiKey: string;
    private site: string;
    private maxRps: number;
    private lastRequestTime = 0;

    constructor(config: DatadogConfig) {
        this.apiKey = config.apiKey;
        this.site = config.site || "datadoghq.com";
        this.maxRps = config.maxRps || 50; // Conservative default
    }

    async send(batch: ForwardBatch): Promise<{ accepted: number; rejected: number }> {
        const series = this.transformMetrics(batch);
        const events = this.transformEdges(batch);

        let accepted = 0;
        let rejected = 0;

        // Send metric series
        if (series.length > 0) {
            const result = await this.postMetrics(series);
            accepted += result.accepted;
            rejected += result.rejected;
        }

        // Send topology events
        if (events.length > 0) {
            const result = await this.postEvents(events);
            accepted += result.accepted;
            rejected += result.rejected;
        }

        return { accepted, rejected };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(`https://api.${this.site}/api/v1/validate`, {
                method: "GET",
                headers: {
                    "DD-API-KEY": this.apiKey,
                    "User-Agent": "aacyn-forwarder/1.0",
                },
                signal: AbortSignal.timeout(5_000),
            });
            return res.ok;
        } catch (err) {
            log.error("[Datadog] Health check failed:" + " " + String(err));
            return false;
        }
    }

    async shutdown(): Promise<void> {
        // No persistent buffers to flush — metrics are sent immediately
    }

    // ── Transformation ─────────────────────────────────────────────────

    private transformMetrics(batch: ForwardBatch): DatadogSeries[] {
        const now = Math.floor(Date.now() / 1000);
        return batch.metrics.flatMap(m => this.buildMetricSeries(m, now));
    }

    private makeSeries(
        metricName: string,
        type: DatadogSeries["type"],
        now: number,
        value: number,
        tags: string[],
        unit: string,
    ): DatadogSeries {
        return { metric: metricName, type, points: [{ timestamp: now, value }], tags, unit };
    }

    private buildMetricSeries(
        metric: ForwardBatch["metrics"][number],
        now: number,
    ): DatadogSeries[] {
        const tags = [`service:${metric.service}`, "source:aacyn", "transport:ebpf"];
        return [
            this.makeSeries("aacyn.service.rate", 2, now, metric.rate, tags, "requests/second"),
            this.makeSeries("aacyn.service.error_rate", 3, now, metric.errorRate, tags, "percent"),
            this.makeSeries("aacyn.service.latency.p50", 3, now, metric.p50Ms, [...tags, "percentile:p50"], "millisecond"),
            this.makeSeries("aacyn.service.latency.p95", 3, now, metric.p95Ms, [...tags, "percentile:p95"], "millisecond"),
            this.makeSeries("aacyn.service.latency.p99", 3, now, metric.p99Ms, [...tags, "percentile:p99"], "millisecond"),
            this.makeSeries("aacyn.service.throughput", 3, now, metric.throughputKbps, tags, "kilobyte/second"),
        ];
    }

    private transformEdges(batch: ForwardBatch): DatadogEvent[] {
        return batch.edges.map(edge => ({
            title: `aacyn connection: ${edge.source} → ${edge.target}`,
            text: [
                `Source: ${edge.source}`,
                `Target: ${edge.target}`,
                `Hit count: ${edge.hitCount}`,
                `Avg latency: ${edge.avgLatencyUs}μs`,
                `Total bytes: ${edge.totalBytes}`,
                `Errors: ${edge.errorCount}`,
                ``,
                `Captured via eBPF kernel probes — zero application instrumentation.`,
            ].join("\n"),
            alert_type: edge.errorCount > 0 ? "warning" as const : "info" as const,
            tags: [
                `source:${edge.source}`,
                `target:${edge.target}`,
                "source:aacyn",
                "transport:ebpf",
            ],
            timestamp: edge.timestamp,
        }));
    }

    // ── HTTP Transport ──────────────────────────────────────────────────

    private async postMetrics(
        series: DatadogSeries[]
    ): Promise<{ accepted: number; rejected: number }> {
        const url = `https://api.${this.site}/api/v2/series`;
        let accepted = 0;
        let rejected = 0;

        // Datadog accepts up to ~10KB per request. Split into chunks of 200 series.
        const CHUNK_SIZE = 200;
        for (let i = 0; i < series.length; i += CHUNK_SIZE) {
            const chunk = series.slice(i, i + CHUNK_SIZE);
            const result = await this.sendMetricChunk(url, chunk);
            accepted += result.accepted;
            rejected += result.rejected;
        }

        return { accepted, rejected };
    }

    private async sendMetricChunk(url: string, chunk: DatadogSeries[]): Promise<{ accepted: number; rejected: number }> {
        await this.throttle();
        let res: Response;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "DD-API-KEY": this.apiKey,
                    "User-Agent": "aacyn-forwarder/1.0",
                },
                body: JSON.stringify({ series: chunk }),
                signal: AbortSignal.timeout(15_000),
            });
        } catch (err) {
            log.error(`[Datadog] Metrics API unreachable: ${(err as Error).message}`);
            metrics.count("aacyn_forwarder_dd_errors", 1, { endpoint: "metrics" });
            return { accepted: 0, rejected: chunk.length };
        }
        if (!res.ok) {
            const body = await res.text();
            log.error(`[Datadog] Metrics API returned ${res.status}: ${body.slice(0, 200)}`);
            metrics.count("aacyn_forwarder_dd_errors", 1, { endpoint: "metrics" });
            return { accepted: 0, rejected: chunk.length };
        }
        const body = await res.json() as { errors?: string[] };
        if (body.errors && body.errors.length > 0) {
            log.warn(`[Datadog] Metrics API errors: ${body.errors.slice(0, 3).join(", ")}`);
            return { accepted: 0, rejected: body.errors.length };
        }
        return { accepted: chunk.length, rejected: 0 };
    }

    private async postEvents(
        events: DatadogEvent[]
    ): Promise<{ accepted: number; rejected: number }> {
        // Datadog events API only accepts one event at a time.
        const url = `https://api.${this.site}/api/v1/events`;
        let accepted = 0;
        let rejected = 0;

        for (const event of events) {
            await this.throttle();

            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "DD-API-KEY": this.apiKey,
                        "User-Agent": "aacyn-forwarder/1.0",
                    },
                    body: JSON.stringify(event),
                    signal: AbortSignal.timeout(10_000),
                });

                if (res.ok) {
                    accepted++;
                } else {
                    rejected++;
                }
            } catch (err) {
                log.error("[Datadog] Event flush failed:" + " " + String(err));
                rejected++;
            }
        }

        return { accepted, rejected };
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
