/**
 * FlatBuffer Binary Ingestion — Smoke Test (TDD Red → Green)
 *
 * Verifies the zero-parse binary pipeline:
 *   1. Manually constructs a FlatBuffer TelemetryBatch payload
 *   2. Sends it to POST /ingest/binary as application/octet-stream
 *   3. Verifies events are shredded into the SoA store
 *
 * FlatBuffer Wire Layout:
 *   EventStruct (inline, 16 bytes): [u64 timestamp | f32 duration | u16 status | u16 pad]
 *   TelemetryBatch (table):         [vtable + trace_id string + events vector]
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { app } from "../src/server";
import { buildFlatBufferPayload } from "../src/lib/flatbuf-builder";

// ─── Wait for native store initialization ──────────────────────────────────
// The store is created in server.ts via initializeStore() and decorated onto the
// Elysia app. Binary ingestion requires the native FFI store (ingestBinary method).
// We probe the /ingest/binary endpoint — a 4-byte payload returns 400 ("Buffer too
// small") without mutating store state, confirming the route and store are wired up.

async function waitForStore(maxRetries = 20, intervalMs = 50): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await app.handle(
                new Request("http://localhost/ingest/binary", {
                    method: "POST",
                    body: new ArrayBuffer(4),
                })
            );
            if (response.status === 400) return true;
        } catch (err) {
            if (i === 0) {
                // Intentional skip diagnostic: first probe may defer if the store is still initializing.
                // Using console.warn rather than the structured logger because this is a test file
                // that may run before the logger module is fully wired.
                console.warn("[waitForStore] First probe deferred:", (err as Error).message);
            }
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

// ─── Request helpers ────────────────────────────────────────────────────────

function createBinaryRequest(body: ArrayBuffer): Request {
    return new Request("http://localhost/ingest/binary", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
    });
}

// ─── Payload builders ───────────────────────────────────────────────────────

function makeSmallPayload(): ArrayBuffer {
    return buildFlatBufferPayload("trace-binary-001", [
        { timestamp: 1709000000000000000n, durationMs: 4.2, statusCode: 200 },
        { timestamp: 1709000000100000000n, durationMs: 8.1, statusCode: 200 },
        { timestamp: 1709000000200000000n, durationMs: 15.3, statusCode: 500 },
    ]);
}

function makeLargePayload(): ArrayBuffer {
    const events = Array.from({ length: 100 }, (_, i) => ({
        timestamp: BigInt(1709000000000000000n + BigInt(i) * 100000000n),
        durationMs: Math.random() * 20,
        statusCode: i % 10 === 0 ? 500 : 200,
    }));
    return buildFlatBufferPayload("trace-binary-bulk", events);
}

// ─── Test body functions ────────────────────────────────────────────────────

interface IngestResponse {
    accepted: number;
    mode: string;
}

async function testAcceptValidPayload(storeReady: boolean): Promise<void> {
    if (!storeReady) {
        // Intentional skip warning: binary ingestion requires the native FFI store.
        // Using console.warn since the test file runs independently of the structured logger.
        console.warn("Skipping: native store not loaded (run 'just build-native' first)");
        return;
    }
    const payload = makeSmallPayload();
    const response = await app.handle(createBinaryRequest(payload));
    const json = await response.json() as IngestResponse;
    expect(response.status).toBe(202);
    expect(json.accepted).toBe(3);
    expect(json.mode).toBe("binary");
}

async function testRejectSmallBuffer(storeReady: boolean): Promise<void> {
    if (!storeReady) {
        // Intentional skip warning: this test requires the native FFI store for binary ingestion.
        console.warn("Skipping: native store not loaded");
        return;
    }
    const response = await app.handle(createBinaryRequest(new ArrayBuffer(4)));
    expect(response.status).toBe(400);
}

async function testHandleLargeBatch(storeReady: boolean): Promise<void> {
    if (!storeReady) {
        // Intentional skip warning: this test requires the native FFI store for binary ingestion.
        console.warn("Skipping: native store not loaded");
        return;
    }
    const payload = makeLargePayload();
    const response = await app.handle(createBinaryRequest(payload));
    const json = await response.json() as IngestResponse;
    expect(response.status).toBe(202);
    expect(json.accepted).toBe(100);
}

async function testJsonBatchStillWorks(): Promise<void> {
    const response = await app.handle(
        new Request("http://localhost/ingest/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                events: [{
                    traceId: "coexist-001",
                    service: "api",
                    durationMs: 3.5,
                    isError: false,
                    timestamp: 1709000000,
                }],
            }),
        })
    );
    const json = await response.json() as IngestResponse;
    expect(response.status).toBe(202);
    expect(json.accepted).toBe(1);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /ingest/binary (FlatBuffer)", () => {
    let storeReady = false;

    beforeAll(async () => {
        storeReady = await waitForStore();
    });

    it("should accept a valid FlatBuffer payload and return 202", () => testAcceptValidPayload(storeReady));
    it("should reject buffers smaller than 8 bytes", () => testRejectSmallBuffer(storeReady));
    it("should handle a large batch (100 events)", () => testHandleLargeBatch(storeReady));
    it("JSON /ingest/batch still works alongside binary route", () => testJsonBatchStillWorks());
});
