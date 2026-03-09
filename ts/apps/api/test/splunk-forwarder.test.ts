/**
 * Splunk Forwarder Tests
 *
 * Validates HEC event transformation, HTTP transport, error handling,
 * chunking behavior, and health check. Uses Bun's mock for fetch.
 *
 * Note: Bun's mock<T>() returns Mock<T> which lacks properties required
 * by TypeScript's typeof fetch (e.g. preconnect). The @ts-expect-error
 * directives on globalThis.fetch assignments bridge this typing gap.
 */

import { test, expect, describe, afterEach, mock } from "bun:test";
import { SplunkForwarder, type SplunkConfig } from "../src/lib/forwarders/splunk";
import type { ForwardBatch } from "../src/lib/forwarder";

const DEFAULT_CONFIG: SplunkConfig = {
    hecUrl: "https://splunk.example.com:8088/services/collector/event",
    hecToken: "test-token-123",
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

/** Mock HEC returning success (code 0). */
function mockHecSuccess(): void {
    setFetchMock(async () =>
        new Response(JSON.stringify({ code: 0, text: "Success" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    );
}

/** Mock HEC returning an error response. */
function mockHecFailure(status: number, body: Record<string, unknown>): void {
    setFetchMock(async () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );
}

describe("SplunkForwarder", () => {
    afterEach(() => {
        // @ts-expect-error — Bun's Mock<T> aliases the original fetch signature without exposing mock methods like mockRestore on the intersected type; runtime ok — mockRestore exists on Mock instances
        (globalThis.fetch as ReturnType<typeof mock>).mockRestore?.();
    });

    // ── Construction ──────────────────────────────────────────────────

    test("has name 'splunk'", () => {
        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        expect(fwd.name).toBe("splunk");
    });

    test("strips trailing slashes from hecUrl", async () => {
        const fwd = new SplunkForwarder({
            ...DEFAULT_CONFIG,
            hecUrl: "https://splunk.example.com:8088/services/collector/event/",
        });
        let capturedUrl = "";
        setFetchMock(async (url) => {
            capturedUrl = url;
            return new Response(JSON.stringify({ code: 0, text: "Success" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        await fwd.send({ metrics: [{ ...SAMPLE_BATCH.metrics[0] }], edges: [] });
        expect(capturedUrl).toBe("https://splunk.example.com:8088/services/collector/event");
    });

    test("defaults index to 'main'", async () => {
        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        let bodyText = "";
        setFetchMock(async (_url, init) => {
            bodyText = (init as RequestInit).body as string;
            return new Response(JSON.stringify({ code: 0, text: "Success" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        await fwd.send({ metrics: [{ ...SAMPLE_BATCH.metrics[0] }], edges: [] });
        const parsed = JSON.parse(bodyText) as Array<{ index: string }>;
        expect(parsed[0].index).toBe("main");
    });

    test("accepts custom index", async () => {
        let bodyText = "";
        setFetchMock(async (_url, init) => {
            bodyText = (init as RequestInit).body as string;
            return new Response(JSON.stringify({ code: 0, text: "Success" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const fwd = new SplunkForwarder({ ...DEFAULT_CONFIG, index: "aacyn_metrics" });
        await fwd.send({ metrics: [{ ...SAMPLE_BATCH.metrics[0] }], edges: [] });
        const parsed = JSON.parse(bodyText) as Array<{ index: string }>;
        expect(parsed[0].index).toBe("aacyn_metrics");
    });

    // ── Send — metrics transformation ─────────────────────────────────

    test("transforms metrics into Splunk HEC events", async () => {
        let bodyText = "";
        let capturedUrl = "";
        setFetchMock(async (url, init) => {
            capturedUrl = url;
            bodyText = (init as RequestInit).body as string;
            return new Response(JSON.stringify({ code: 0, text: "Success" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(capturedUrl).toBe(DEFAULT_CONFIG.hecUrl);
        const events = JSON.parse(bodyText) as Array<Record<string, unknown>>;
        expect(events.length).toBe(3); // 2 metrics + 1 edge

        const metricEvent = events.find(e => e.sourcetype === "aacyn:metrics")!;
        expect(metricEvent).toBeDefined();
        expect(metricEvent.source).toBe("aacyn");
        expect((metricEvent.event as Record<string, unknown>).type).toBe("metric");
        expect((metricEvent.event as Record<string, unknown>).service).toBe("auth-service");

        const topoEvent = events.find(e => e.sourcetype === "aacyn:topology")!;
        expect(topoEvent).toBeDefined();
        expect((topoEvent.event as Record<string, unknown>).type).toBe("topology_edge");

        expect(result.accepted).toBe(3);
        expect(result.rejected).toBe(0);
    });

    test("returns correct accepted/rejected counts on success", async () => {
        mockHecSuccess();

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(3);
        expect(result.rejected).toBe(0);
    });

    // ── Empty batch ──────────────────────────────────────────────────

    test("handles empty batch without making HTTP requests", async () => {
        setFetchMock(() => {
            throw new Error("Should not be called");
        });

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send({ metrics: [], edges: [] });

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(0);
    });

    // ── Error handling ────────────────────────────────────────────────

    test("rejects all events when HEC returns non-200 status", async () => {
        mockHecFailure(503, { text: "Service Unavailable" });

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(3);
    });

    test("rejects all events when HEC returns code != 0", async () => {
        mockHecFailure(200, { code: 4, text: "Invalid token" });

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(3);
    });

    test("rejects all events on network error", async () => {
        setFetchMock(() => Promise.reject(new Error("Connection refused")));

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(3);
    });

    // ── Chunking ──────────────────────────────────────────────────────

    test("chunks large batches across multiple HTTP requests", async () => {
        let requestCount = 0;
        setFetchMock(async () => {
            requestCount++;
            return new Response(JSON.stringify({ code: 0, text: "Success" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        // 600 metrics → 2 chunks (500 + 100)
        const largeBatch: ForwardBatch = {
            metrics: Array.from({ length: 600 }, (_, i) => ({
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

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(largeBatch);

        expect(requestCount).toBe(2);
        expect(result.accepted).toBe(600);
        expect(result.rejected).toBe(0);
    });

    // ── Health check ──────────────────────────────────────────────────

    test("healthCheck returns true when Splunk responds 200", async () => {
        setFetchMock(async (url) => {
            expect(url).toContain("/health");
            return new Response("OK", { status: 200 });
        });

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(true);
    });

    test("healthCheck returns false on non-200", async () => {
        setFetchMock(async () =>
            new Response("Unauthorized", { status: 401 })
        );

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(false);
    });

    test("healthCheck returns false on network error", async () => {
        setFetchMock(() => Promise.reject(new Error("ECONNREFUSED")));

        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(false);
    });

    // ── Shutdown ──────────────────────────────────────────────────────

    test("shutdown resolves immediately (no persistent buffers)", async () => {
        const fwd = new SplunkForwarder(DEFAULT_CONFIG);
        await expect(fwd.shutdown()).resolves.toBeUndefined();
    });

    // ── Authorization header ──────────────────────────────────────────

    test("sends correct Splunk authorization header", async () => {
        let capturedHeaders: Record<string, string> | null = null;
        setFetchMock(async (_url, init) => {
            capturedHeaders = (init as RequestInit).headers as Record<string, string>;
            return new Response(JSON.stringify({ code: 0, text: "Success" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const fwd = new SplunkForwarder({
            hecUrl: "https://splunk.internal:8088/services/collector/event",
            hecToken: "splunk-hec-token-abc",
        });
        await fwd.send({ metrics: [{ ...SAMPLE_BATCH.metrics[0] }], edges: [] });

        expect(capturedHeaders!["Authorization"]).toBe("Splunk splunk-hec-token-abc");
        expect(capturedHeaders!["Content-Type"]).toBe("application/json");
    });
});
