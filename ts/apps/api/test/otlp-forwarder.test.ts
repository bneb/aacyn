/**
 * OTLP Forwarder Tests
 *
 * Validates OTLP protobuf encoding, HTTP transport, error handling,
 * health check, and header parsing. Uses Bun's mock for fetch.
 *
 * Note: Bun's mock<T>() returns Mock<T> which lacks properties required
 * by TypeScript's typeof fetch (e.g. preconnect). The @ts-expect-error
 * directives on globalThis.fetch assignments bridge this typing gap.
 */

import { test, expect, describe, afterEach, mock } from "bun:test";
import { OtlpForwarder } from "../src/lib/forwarders/otlp";
import type { ForwardBatch } from "../src/lib/forwarder";

const DEFAULT_CONFIG = {
    endpoint: "https://otlp.example.com:4318",
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

/** Mock OTLP endpoint returning 200. */
function mockOtlpSuccess(): void {
    setFetchMock(async () =>
        new Response(new Uint8Array(0), {
            status: 200,
            headers: { "Content-Type": "application/x-protobuf" },
        })
    );
}

/** Mock OTLP endpoint returning an error. */
function mockOtlpFailure(status: number): void {
    setFetchMock(async () =>
        new Response("error", { status })
    );
}

describe("OtlpForwarder", () => {
    afterEach(() => {
        // @ts-expect-error — Bun's Mock<T> aliases the original fetch signature without exposing mock methods like mockRestore on the intersected type; runtime ok — mockRestore exists on Mock instances
        (globalThis.fetch as ReturnType<typeof mock>).mockRestore?.();
    });

    // ── Construction ──────────────────────────────────────────────────

    test("has name 'otlp'", () => {
        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        expect(fwd.name).toBe("otlp");
    });

    test("appends /v1/traces to endpoint", async () => {
        const fwd = new OtlpForwarder({ endpoint: "https://collector.example.com:4318" });
        let capturedUrl = "";
        setFetchMock(async (url) => {
            capturedUrl = url;
            return new Response(new Uint8Array(0), { status: 200 });
        });
        await fwd.send(SAMPLE_BATCH);
        expect(capturedUrl).toBe("https://collector.example.com:4318/v1/traces");
    });

    test("strips trailing slashes from endpoint", async () => {
        let capturedUrl = "";
        setFetchMock(async (url) => {
            capturedUrl = url;
            return new Response(new Uint8Array(0), { status: 200 });
        });
        const fwd = new OtlpForwarder({ endpoint: "https://collector.example.com:4318/" });
        await fwd.send(SAMPLE_BATCH);
        expect(capturedUrl).toBe("https://collector.example.com:4318/v1/traces");
    });

    // ── Send — protobuf encoding ──────────────────────────────────────

    test("sends protobuf-encoded ExportTraceServiceRequest", async () => {
        let contentType = "";
        let bodyBytes: Uint8Array | null = null;
        setFetchMock(async (_url, init) => {
            contentType = (init as RequestInit).headers!["Content-Type" as keyof HeadersInit] as string;
            bodyBytes = new Uint8Array((init as RequestInit).body as ArrayBuffer);
            return new Response(new Uint8Array(0), { status: 200 });
        });

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(contentType).toBe("application/x-protobuf");
        expect(bodyBytes!.length).toBeGreaterThan(0);
        expect(result.accepted).toBe(1);
        expect(result.rejected).toBe(0);
    });

    test("sends to endpoint/v1/traces", async () => {
        let capturedUrl = "";
        setFetchMock(async (url) => {
            capturedUrl = url;
            return new Response(new Uint8Array(0), { status: 200 });
        });

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        await fwd.send(SAMPLE_BATCH);

        expect(capturedUrl).toBe("https://otlp.example.com:4318/v1/traces");
    });

    test("returns accepted when endpoint responds 200", async () => {
        mockOtlpSuccess();

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(1);
        expect(result.rejected).toBe(0);
    });

    // ── Empty batch ──────────────────────────────────────────────────

    test("handles empty batch without making HTTP requests", async () => {
        setFetchMock(() => {
            throw new Error("Should not be called");
        });

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        const result = await fwd.send({ metrics: [], edges: [] });

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(0);
    });

    // ── Error handling ────────────────────────────────────────────────

    test("rejects when endpoint returns non-200 status", async () => {
        mockOtlpFailure(503);

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(1);
    });

    test("rejects on network error", async () => {
        setFetchMock(() => Promise.reject(new Error("Connection refused")));

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        const result = await fwd.send(SAMPLE_BATCH);

        expect(result.accepted).toBe(0);
        expect(result.rejected).toBe(1);
    });

    // ── Health check ──────────────────────────────────────────────────

    test("healthCheck returns true when endpoint responds 200", async () => {
        setFetchMock(async (url) => {
            expect(url).not.toContain("/v1/traces");
            return new Response("OK", { status: 200 });
        });

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(true);
    });

    test("healthCheck returns false on non-200", async () => {
        setFetchMock(async () =>
            new Response("Unauthorized", { status: 401 })
        );

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(false);
    });

    test("healthCheck returns false on network error", async () => {
        setFetchMock(() => Promise.reject(new Error("ECONNREFUSED")));

        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        expect(await fwd.healthCheck()).toBe(false);
    });

    // ── Shutdown ──────────────────────────────────────────────────────

    test("shutdown resolves immediately (no persistent buffers)", async () => {
        const fwd = new OtlpForwarder(DEFAULT_CONFIG);
        await expect(fwd.shutdown()).resolves.toBeUndefined();
    });

    // ── Custom headers ────────────────────────────────────────────────

    test("sends configured custom headers", async () => {
        let capturedHeaders: Record<string, string> | null = null;
        setFetchMock(async (_url, init) => {
            capturedHeaders = (init as RequestInit).headers as Record<string, string>;
            return new Response(new Uint8Array(0), { status: 200 });
        });

        const fwd = new OtlpForwarder({
            endpoint: "https://otlp.example.com:4318",
            headers: { Authorization: "Bearer test123", "X-Custom": "value" },
        });
        await fwd.send(SAMPLE_BATCH);

        expect(capturedHeaders!["Authorization"]).toBe("Bearer test123");
        expect(capturedHeaders!["X-Custom"]).toBe("value");
        expect(capturedHeaders!["Content-Type"]).toBe("application/x-protobuf");
    });

    // ── Header parsing ────────────────────────────────────────────────

    test("parseHeaders parses comma-separated key=value pairs", () => {
        const result = OtlpForwarder.parseHeaders("Authorization=Bearer+token123,foo=bar");
        expect(result).toEqual({ Authorization: "Bearer token123", foo: "bar" });
    });

    test("parseHeaders returns empty object for undefined input", () => {
        expect(OtlpForwarder.parseHeaders(undefined)).toEqual({});
    });

    test("parseHeaders returns empty object for empty string", () => {
        expect(OtlpForwarder.parseHeaders("")).toEqual({});
    });

    test("parseHeaders skips malformed entries", () => {
        const result = OtlpForwarder.parseHeaders("valid=yes,noequals,also=good");
        expect(result).toEqual({ valid: "yes", also: "good" });
    });
});
