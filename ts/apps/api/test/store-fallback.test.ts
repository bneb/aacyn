/**
 * Tests for the V8MapStore (EventStore) fallback — in-memory store used
 * when the native libaacyn engine is unavailable.
 *
 * These tests import the singleton directly, avoiding the server bootstrap
 * and the native store dependency.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { store, type IngestEvent } from "../src/lib/store";

function makeEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
    return {
        traceId: `trace-${Math.random().toString(36).slice(2, 10)}`,
        service: "test-service",
        durationMs: 42,
        isError: false,
        timestamp: 1_000_000_000,
        ...overrides,
    };
}

describe("EventStore fallback", () => {
    beforeEach(() => {
        store.clear();
    });

    // ── Core CRUD ─────────────────────────────────────────────────────────

    test("ingestBatch returns count of ingested events", () => {
        const events = [makeEvent(), makeEvent()];
        const count = store.ingestBatch(events);
        expect(count).toBe(2);
    });

    test("ingestBatch stores events that can be queried back", () => {
        const e1 = makeEvent({ traceId: "abc", durationMs: 10, isError: false, timestamp: 100 });
        const e2 = makeEvent({ traceId: "def", durationMs: 20, isError: true, timestamp: 200 });
        store.ingestBatch([e1, e2]);

        const results = store.query({});
        expect(results).toHaveLength(2);
    });

    test("query returns all events when no filters are applied", () => {
        store.ingestBatch([makeEvent({ traceId: "a" }), makeEvent({ traceId: "b" }), makeEvent({ traceId: "c" })]);
        expect(store.query({})).toHaveLength(3);
    });

    test("query filters by startNs", () => {
        store.ingestBatch([
            makeEvent({ traceId: "early", timestamp: 100 }),
            makeEvent({ traceId: "mid", timestamp: 200 }),
            makeEvent({ traceId: "late", timestamp: 300 }),
        ]);

        const results = store.query({ startNs: 200 });
        expect(results).toHaveLength(2);
        expect(results[0].timestamp).toBe(200);
        expect(results[1].timestamp).toBe(300);
    });

    test("query filters by endNs", () => {
        store.ingestBatch([
            makeEvent({ traceId: "early", timestamp: 100 }),
            makeEvent({ traceId: "mid", timestamp: 200 }),
            makeEvent({ traceId: "late", timestamp: 300 }),
        ]);

        const results = store.query({ endNs: 200 });
        expect(results).toHaveLength(2);
        expect(results[0].timestamp).toBe(100);
        expect(results[1].timestamp).toBe(200);
    });

    test("query filters by errorOnly", () => {
        store.ingestBatch([
            makeEvent({ traceId: "ok", isError: false }),
            makeEvent({ traceId: "err", isError: true }),
        ]);

        const results = store.query({ errorOnly: true });
        expect(results).toHaveLength(1);
        expect(results[0].isError).toBe(true);
    });

    test("query respects limit", () => {
        store.ingestBatch([
            makeEvent({ traceId: "a", timestamp: 1 }),
            makeEvent({ traceId: "b", timestamp: 2 }),
            makeEvent({ traceId: "c", timestamp: 3 }),
        ]);

        const results = store.query({ limit: 2 });
        expect(results).toHaveLength(2);
    });

    test("query returns empty array when no events match", () => {
        store.ingestBatch([makeEvent({ timestamp: 100 })]);

        const results = store.query({ startNs: 200 });
        expect(results).toEqual([]);
    });

    test("query returns empty array when store is empty", () => {
        expect(store.query({})).toEqual([]);
    });

    // ── getByTraceId ───────────────────────────────────────────────────────

    test("getByTraceId retrieves a stored event by trace ID", () => {
        const event = makeEvent({ traceId: "find-me", service: "svc", durationMs: 99, isError: true, timestamp: 500 });
        store.ingestBatch([event]);

        const result = store.getByTraceId("find-me");
        expect(result).toBeDefined();
        expect(result!.traceId).toBe("find-me");
        expect(result!.service).toBe("svc");
        expect(result!.durationMs).toBe(99);
        expect(result!.isError).toBe(true);
        expect(result!.timestamp).toBe(500);
    });

    test("getByTraceId returns undefined for unknown trace ID", () => {
        store.ingestBatch([makeEvent({ traceId: "known" })]);
        expect(store.getByTraceId("unknown")).toBeUndefined();
    });

    test("getByTraceId returns undefined on empty store", () => {
        expect(store.getByTraceId("anything")).toBeUndefined();
    });

    // ── Native-engine-only methods return empty / zero gracefully ──────────

    test("ingestBinary returns 0 instead of throwing", () => {
        expect(store.ingestBinary(new ArrayBuffer(16))).toBe(0);
    });

    test("scanDurationMax returns 0 instead of throwing", () => {
        expect(store.scanDurationMax()).toBe(0);
    });

    test("scanErrorCount returns 0 instead of throwing", () => {
        expect(store.scanErrorCount()).toBe(0);
    });

    test("setRules does not throw", () => {
        expect(() => store.setRules(new Uint8Array(16), 1)).not.toThrow();
    });

    test("eventsDropped returns 0 instead of throwing", () => {
        expect(store.eventsDropped()).toBe(0);
    });

    test("extractRaw returns empty buffer instead of throwing", () => {
        const result = store.extractRaw(0, 10);
        expect(result.buffer).toBeInstanceOf(Buffer);
        expect(result.extracted).toBe(0);
    });

    test("ebpfAttach returns 0 instead of throwing", () => {
        expect(store.ebpfAttach("/path/to/bpf.o")).toBe(0);
    });

    test("ebpfPoll returns 0 instead of throwing", () => {
        expect(store.ebpfPoll(100)).toBe(0);
    });

    test("ebpfDetach does not throw", () => {
        expect(() => store.ebpfDetach()).not.toThrow();
    });

    // ── Safe fallback methods return empty / zero ──────────────────────────

    test("topologyEdges returns empty array", () => {
        expect(store.topologyEdges()).toEqual([]);
    });

    test("discoveredServices returns empty array", () => {
        expect(store.discoveredServices()).toEqual([]);
    });

    test("dropCounts returns zero counters", () => {
        expect(store.dropCounts()).toEqual({ standard: 0, critical: 0 });
    });

    test("ebpfDrainCount returns 0", () => {
        expect(store.ebpfDrainCount()).toBe(0);
    });

    // ── Metadata methods ──────────────────────────────────────────────────

    test("count and size start at 0", () => {
        expect(store.count).toBe(0);
        expect(store.size).toBe(0);
    });

    test("count and size reflect ingested events", () => {
        store.ingestBatch([makeEvent(), makeEvent()]);
        expect(store.count).toBe(2);
        expect(store.size).toBe(2);
    });

    test("head and nativeLen match event count", () => {
        store.ingestBatch([makeEvent()]);
        expect(store.head()).toBe(1);
        expect(store.nativeLen()).toBe(1);
    });

    test("byteSize returns a rough estimate", () => {
        store.ingestBatch([makeEvent()]);
        const bytes = store.byteSize();
        expect(bytes).toBeGreaterThan(0);
    });

    test("count includes all ingested events even with duplicate traceIds", () => {
        // The store overwrites on same traceId but _count is monotonic
        store.ingestBatch([makeEvent({ traceId: "dup" })]);
        store.ingestBatch([makeEvent({ traceId: "dup" })]);
        expect(store.count).toBe(2);
        // size reflects unique keys
        expect(store.size).toBe(1);
    });

    // ── Multiple ingestBatch calls ─────────────────────────────────────────

    test("accumulates events across multiple ingestBatch calls", () => {
        expect(store.count).toBe(0);

        const count1 = store.ingestBatch([makeEvent({ traceId: "a" }), makeEvent({ traceId: "b" })]);
        expect(count1).toBe(2);
        expect(store.count).toBe(2);

        const count2 = store.ingestBatch([makeEvent({ traceId: "c" })]);
        expect(count2).toBe(1);
        expect(store.count).toBe(3);

        const count3 = store.ingestBatch([makeEvent({ traceId: "d" }), makeEvent({ traceId: "e" })]);
        expect(count3).toBe(2);
        expect(store.count).toBe(5);
    });

    test("all ingested events are queryable after multiple batches", () => {
        store.ingestBatch([makeEvent({ traceId: "x", timestamp: 1 })]);
        store.ingestBatch([makeEvent({ traceId: "y", timestamp: 2 })]);

        const results = store.query({});
        expect(results).toHaveLength(2);
    });

    // ── Lifecycle ──────────────────────────────────────────────────────────

    test("clear removes all events", () => {
        store.ingestBatch([makeEvent(), makeEvent(), makeEvent()]);
        expect(store.count).toBe(3);

        store.clear();
        expect(store.count).toBe(0);
        expect(store.size).toBe(0);
        expect(store.query({})).toEqual([]);
    });

    test("destroy clears all events", () => {
        store.ingestBatch([makeEvent()]);
        store.destroy();
        expect(store.count).toBe(0);
        expect(store.query({})).toEqual([]);
    });

    test("sync is a no-op", () => {
        // Should not throw
        store.sync();
        store.ingestBatch([makeEvent()]);
        store.sync();
        expect(store.count).toBe(1);
    });

    // ── Edge cases ─────────────────────────────────────────────────────────

    test("ingestBatch with empty array returns 0", () => {
        expect(store.ingestBatch([])).toBe(0);
    });

    test("ingestBatch handles many events", () => {
        const events: IngestEvent[] = [];
        for (let i = 0; i < 100; i++) {
            events.push(makeEvent({ traceId: `bulk-${i}`, timestamp: i }));
        }
        expect(store.ingestBatch(events)).toBe(100);
        expect(store.count).toBe(100);
        expect(store.size).toBe(100);
    });

    test("query with startNs and endNs together", () => {
        store.ingestBatch([
            makeEvent({ traceId: "a", timestamp: 10 }),
            makeEvent({ traceId: "b", timestamp: 20 }),
            makeEvent({ traceId: "c", timestamp: 30 }),
            makeEvent({ traceId: "d", timestamp: 40 }),
        ]);

        const results = store.query({ startNs: 15, endNs: 35 });
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.timestamp).sort()).toEqual([20, 30]);
    });
});
