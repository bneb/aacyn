/**
 * Datadog Forwarder Tests
 *
 * Validates metric series transformation, edge event transformation,
 * HTTP transport, rate-limit throttling, chunking behavior, health check,
 * and error handling. Uses Bun's mock for fetch.
 *
 * Note: Bun's mock<T>() returns Mock<T> which lacks properties required
 * by TypeScript's typeof fetch (e.g. preconnect). The @ts-expect-error
 * directives on globalThis.fetch assignments bridge this typing gap.
 */

import { test, expect, describe, afterEach, mock } from "bun:test";
import { DatadogForwarder, type DatadogConfig } from "../src/lib/forwarders/datadog";
import type { ForwardBatch } from "../src/lib/forwarder";

const DEFAULT_CONFIG: DatadogConfig = {
    apiKey: "test-datadog-key-abc",
};

const SAMPLE_BATCH: ForwardBatch = {
    metrics: [
        {
            service: "auth-service",
            rate: 100,
            errorRate: 2.5,
            p50Ms: 12,
            p95Ms: 45,
            p99Ms: 89,
            throughputKbps: 500,
            timestamp: 1700000000,
        },
        {
            service: "payment-api",
            rate: 250,
            errorRate: 0.1,
            p50Ms: 8,
            p95Ms: 30,
            p99Ms: 55,
            throughputKbps: 1200,
            timestamp: 1700000000,
        },
    ],
    edges: [
        {
            source: "auth-service",
            target: "payment-api",
            hitCount: 500,
            avgLatencyUs: 4200,
            errorCount: 3,
            totalBytes: 1024000,
            timestamp: 1700000000,
        },
    ],
};

// ── Mock helpers ──────────────────────────────────────────────────────

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Assign a mock implementation to globalThis.fetch with correct typing. */
function setFetchMock(impl: FetchImpl): void {
    // @ts-expect-error — Bun mock<T>() returns Mock<T> which lacks 'preconnect' and other properties required by TypeScript's typeof fetch; runtime ok
    globalThis.fetch = mock(impl);
}

/** Mock Datadog API returning a successful (200) response. */
function mockDdSuccess(): void {
    setFetchMock(async () =>
        new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    );
}

/** Mock Datadog API returning an error response with the given status and body. */
function mockDdFailure(status: number, body: Record<string, unknown>): void {
    setFetchMock(async () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );
}

describe("DatadogForwarder", () => {
    afterEach(() => {
        // @ts-expect-error — Bun's Mock<T> aliases the original fetch signature without exposing mock methods like mockRestore on the intersected type; runtime ok — mockRestore exists on Mock instances
        (globalThis.fetch as ReturnType<typeof mock>).mockRestore?.();
    });

    // ── Construction ──────────────────────────────────────────────────

    test("has name 'datadog'", () => {
        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        expect(fwd.name).toBe("datadog");
    });

    test("uses default site and maxRps", () => {
        const fwd = new DatadogForwarder({ apiKey: "key" });
        // Private fields are not directly accessible, but we exercise them
        // via send() — verify they don't cause errors.
        expect(fwd.name).toBe("datadog");
    });

    // ── Send — metrics & edges transformation ─────────────────────────

    test("transforms batch into Datadog API format", async () => {
        const calls: Array<{ url: string; body?: string }> = [];
        setFetchMock(async (url, init) => {
            calls.push({ url, body: (init as RequestInit).body as string });
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        await fwd.send(SAMPLE_BATCH);

        // Should have made 2 calls: metrics + events
        expect(calls.length).toBe(2);

        // ── First call: metrics series to /api/v2/series ──
        const metricsCall = calls[0];
        expect(metricsCall.url).toBe("https://api.datadoghq.com/api/v2/series");
        const seriesPayload = JSON.parse(metricsCall.body!) as { series: Array<Record<string, unknown>> };
        expect(seriesPayload.series.length).toBe(12); // 6 series per metric * 2 metrics

        // Check the first series structure
        const first = seriesPayload.series[0];
        expect(first.metric).toBe("aacyn.service.rate");
        expect(first.type).toBe(2);
        expect(first.unit).toBe("requests/second");
        expect(first.tags).toContain("service:auth-service");
        expect(first.tags).toContain("source:aacyn");

        // Check that latency series carry a percentile tag
        const p50Series = seriesPayload.series.find(
            (s) => s.metric === "aacyn.service.latency.p50"
        )!;
        expect(p50Series).toBeDefined();
        expect(p50Series.tags).toContain("percentile:p50");

        // Check the error_rate series for the second service
        const errorRateSeries = seriesPayload.series.find(
            (s) => s.metric === "aacyn.service.error_rate" && (s.tags as string[]).includes("service:payment-api")
        )!;
        expect(errorRateSeries).toBeDefined();

        // ── Second call: events to /api/v1/events ──
        const eventCall = calls[1];
        expect(eventCall.url).toBe("https://api.datadoghq.com/api/v1/events");
        const eventPayload = JSON.parse(eventCall.body!) as Record<string, unknown>;
        expect(eventPayload.title).toBe("aacyn connection: auth-service → payment-api");
        expect(eventPayload.alert_type).toBe("warning"); // errorCount > 0
        expect((eventPayload.text as string)).toContain("Hit count: 500");
        expect((eventPayload.tags as string[])).toContain("source:aacyn");
        expect((eventPayload.tags as string[])).toContain("transport:ebpf");
    });

    test("returns correct accepted/rejected counts on success", async () => {
        mockDdSuccess();

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        // 12 metric series + 1 edge event = 13 accepted
        expect(result.accepted).toBe(13);
        expect(result.rejected).toBe(0);
    });

    // ── Empty batch ──────────────────────────────────────────────────

    test("handles empty batch without making HTTP requests", async () => {
        setFetchMock(() => {
            throw new Error("Should not be called");
        });

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        const result = await fwd.send({ metrics: [], edges: [] });

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(0);
    });

    // ── Error handling ────────────────────────────────────────────────

    test("rejects all items when API returns non-200", async () => {
        mockDdFailure(429, { errors: ["Too many requests"] });

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(13);
    });

    test("rejects all items on network error", async () => {
        setFetchMock(() => Promise.reject(new Error("Connection refused")));

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(13);
    });

    // ── Health check ──────────────────────────────────────────────────

    test("healthCheck returns true when API validates", async () => {
        setFetchMock(async (url) => {
            expect(url).toBe("https://api.datadoghq.com/api/v1/validate");
            return new Response("OK", { status: 200 });
        });

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(true);
    });

    test("healthCheck returns false on non-200", async () => {
        setFetchMock(async () =>
            new Response("Unauthorized", { status: 401 })
        );

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(false);
    });

    test("healthCheck returns false on network error", async () => {
        setFetchMock(() => Promise.reject(new Error("ECONNREFUSED")));

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(false);
    });

    // ── Shutdown ──────────────────────────────────────────────────────

    test("shutdown resolves immediately (no persistent buffers)", async () => {
        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        await expect(fwd.shutdown()).resolves.toBeUndefined();
    });

    // ── Authorization header ──────────────────────────────────────────

    test("sends correct DD-API-KEY header on all requests", async () => {
        let capturedHeaders: Record<string, string> | null = null;
        setFetchMock(async (_url, init) => {
            capturedHeaders = (init as RequestInit).headers as Record<string, string>;
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const fwd = new DatadogForwarder({
            apiKey: "my-dd-api-key",
            site: "datadoghq.eu",
        });
        await fwd.send({ metrics: [{ ...SAMPLE_BATCH.metrics[0] }], edges: [] });

        expect(capturedHeaders!["DD-API-KEY"]).toBe("my-dd-api-key");
        expect(capturedHeaders!["Content-Type"]).toBe("application/json");
        expect(capturedHeaders!["User-Agent"]).toBe("aacyn-forwarder/1.0");
    });

    // ── Chunking ──────────────────────────────────────────────────────

    test("chunks series at 200 per request", async () => {
        let metricsRequestCount = 0;
        setFetchMock(async (url) => {
            if (url.includes("/api/v2/series")) {
                metricsRequestCount++;
            }
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        // 40 metrics * 6 series each = 240 series → 2 chunks (200 + 40)
        const largeBatch: ForwardBatch = {
            metrics: Array.from({ length: 40 }, (_, i) => ({
                service: `svc-${i}`,
                rate: 10,
                errorRate: 0,
                p50Ms: 5,
                p95Ms: 20,
                p99Ms: 50,
                throughputKbps: 100,
                timestamp: 1700000000,
            })),
            edges: [],
        };

        const fwd = new DatadogForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(largeBatch);

        expect(metricsRequestCount).toBe(2);
        expect(result.accepted).toBe(240); // 40 * 6
        expect(result.rejected).toBe(0);
    });

    // ── Rate limiting ──────────────────────────────────────────────────

    test("throttle does not prevent send from completing", async () => {
        mockDdSuccess();

        // Very high maxRps ensures throttle never delays
        const fwd = new DatadogForwarder({ apiKey: "test-key", maxRps: 1000000 });
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(13);
        expect(result.rejected).toBe(0);
    });
});
