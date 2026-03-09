/**
 * E2E Smoke Test — aacyn API
 *
 * Validates the full ingest → store → query pipeline using
 * 10,000 synthetic RED metrics. Asserts data integrity and
 * sub-50ms query latency.
 *
 * Uses Elysia's app.handle() for zero-network-overhead testing.
 */

import { test, expect, describe } from "bun:test";
import { app } from "../src/server";

const INGEST_COUNT = 10_000;
const LATENCY_GATE_MS = 50;

const payloads = Array.from({ length: INGEST_COUNT }, (_, i) => ({
    traceId: `trace-${crypto.randomUUID()}`,
    service: i % 2 === 0 ? "auth-service" : "payment-gateway",
    durationMs: Math.random() * 200,
    isError: Math.random() > 0.99,
    timestamp: Date.now(),
}));

describe("E2E Smoke Test: Ingest → Query Pipeline", () => {
    test("health endpoint returns ok", healthEndpointReturnsOk);
    test(
        `ingest ${INGEST_COUNT.toLocaleString()} RED metrics → 202 Accepted`,
        ingestMetricsReturnsAccepted,
    );
    test("query a specific trace by ID → exact match", querySpecificTraceById);
    test(
        `query latency is under ${LATENCY_GATE_MS}ms`,
        queryLatencyIsUnderGate,
    );
    test("query a non-existent trace → 404", queryNonExistentTrace);
    test(
        "rejects batch with missing required field → 422",
        rejectsBatchWithMissingField,
    );
});

async function healthEndpointReturnsOk() {
    const res = await app.handle(
        new Request("http://localhost/health"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
}

async function ingestMetricsReturnsAccepted() {
    const start = performance.now();

    const res = await app.handle(
        new Request("http://localhost/ingest/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: payloads }),
        }),
    );

    const elapsed = performance.now() - start;

    expect(res.status).toBe(202);

    const body = await res.json() as { accepted: number; timestamp: number };
    expect(body.accepted).toBe(INGEST_COUNT);
    expect(body.timestamp).toBeGreaterThan(0);

    console.log(
        `✅ Ingested ${INGEST_COUNT.toLocaleString()} events in ${elapsed.toFixed(2)}ms`,
    );
}

async function querySpecificTraceById() {
    const targetTrace = payloads[5000].traceId;

    const start = performance.now();

    const res = await app.handle(
        new Request(`http://localhost/query/trace/${targetTrace}`),
    );

    const elapsed = performance.now() - start;

    expect(res.status).toBe(200);

    const body = await res.json() as {
        traceId: string;
        spanCount: number;
        totalDurationMs: number;
        spans: { service: string; timestamp: number; spanId: string }[];
    };
    expect(body.traceId).toBe(targetTrace);
    expect(body.spanCount).toBeGreaterThan(0);
    expect(body.spans.length).toBeGreaterThan(0);
    expect(body.spans[0].service).toBe("auth-service");
    expect(body.spans[0].timestamp).toBeGreaterThan(0);

    console.log(`✅ Queried trace in ${elapsed.toFixed(2)}ms`);
}

async function queryLatencyIsUnderGate() {
    const sampleSize = 100;
    const latencies: number[] = [];

    for (let i = 0; i < sampleSize; i++) {
        const idx = Math.floor(Math.random() * INGEST_COUNT);
        const target = payloads[idx].traceId;

        const start = performance.now();
        const res = await app.handle(
            new Request(`http://localhost/query/trace/${target}`),
        );
        const elapsed = performance.now() - start;

        expect(res.status).toBe(200);
        latencies.push(elapsed);
    }

    const p99 = latencies.sort((a, b) => a - b)[Math.floor(sampleSize * 0.99)];
    const avg = latencies.reduce((a, b) => a + b, 0) / sampleSize;

    expect(p99).toBeLessThan(LATENCY_GATE_MS);

    console.log(
        `✅ Query latency — avg: ${avg.toFixed(2)}ms, p99: ${p99.toFixed(2)}ms (gate: ${LATENCY_GATE_MS}ms)`,
    );
}

async function queryNonExistentTrace() {
    const res = await app.handle(
        new Request("http://localhost/query/trace/does-not-exist"),
    );
    expect(res.status).toBe(404);
}

async function rejectsBatchWithMissingField() {
    const res = await app.handle(
        new Request("http://localhost/ingest/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                events: [
                    {
                        // missing traceId
                        service: "auth-service",
                        durationMs: 100,
                        isError: false,
                        timestamp: Date.now(),
                    },
                ],
            }),
        }),
    );
    expect(res.status).toBe(422);

    const body = await res.json() as { error?: string; message?: string; errors?: unknown };
    expect(body.error || body.message || body.errors).toBeDefined();
}
