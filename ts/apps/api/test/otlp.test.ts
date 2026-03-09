/**
 * Tests for OTLP span → aacyn event conversion,
 * tag dictionary, and protobuf decoding.
 */

import { describe, test, expect } from "bun:test";
import { spanToEvent, otlpToEvents, TagDictionary } from "../src/routes/otlp";
import { decodeExportTraceServiceRequest } from "../src/lib/otlp-decode";

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const NORMAL_SPAN = {
    traceId: "abc123",
    spanId: "span1",
    name: "GET /users",
    startTimeUnixNano: "1710000000000000000",
    endTimeUnixNano:   "1710000000042500000",
    status: { code: 0 },
};
const NORMAL_SERVICE = "api-gateway";

const ERROR_SPAN = {
    traceId: "err001",
    spanId: "span2",
    name: "POST /checkout",
    startTimeUnixNano: "1710000000000000000",
    endTimeUnixNano:   "1710000000100000000",
    status: { code: 2, message: "Internal Server Error" },
};
const ERROR_SERVICE = "checkout-service";

const MISSING_STATUS_SPAN = {
    traceId: "t1",
    spanId: "s1",
    name: "query",
    startTimeUnixNano: "1710000000000000000",
    endTimeUnixNano:   "1710000000001000000",
};
const MISSING_STATUS_SERVICE = "db";

const FULL_PAYLOAD = {
    resourceSpans: [
        {
            resource: {
                attributes: [
                    { key: "service.name", value: { stringValue: "user-api" } },
                ],
            },
            scopeSpans: [
                {
                    scope: { name: "@opentelemetry/auto-http" },
                    spans: [
                        {
                            traceId: "t1",
                            spanId: "s1",
                            name: "GET /users",
                            startTimeUnixNano: "1710000000000000000",
                            endTimeUnixNano:   "1710000000050000000",
                            status: { code: 0 },
                        },
                        {
                            traceId: "t2",
                            spanId: "s2",
                            name: "GET /users/123",
                            startTimeUnixNano: "1710000001000000000",
                            endTimeUnixNano:   "1710000001025000000",
                            status: { code: 2 },
                        },
                    ],
                },
            ],
        },
    ],
};

const MISSING_RESOURCE_PAYLOAD = {
    resourceSpans: [
        {
            scopeSpans: [
                {
                    spans: [
                        {
                            traceId: "t1",
                            spanId: "s1",
                            name: "op",
                            startTimeUnixNano: "1000000000",
                            endTimeUnixNano:   "2000000000",
                        },
                    ],
                },
            ],
        },
    ],
};

const MULTI_RESOURCE_PAYLOAD = {
    resourceSpans: [
        {
            resource: {
                attributes: [{ key: "service.name", value: { stringValue: "svc-a" } }],
            },
            scopeSpans: [{ spans: [{
                traceId: "t1", spanId: "s1", name: "op1",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano:   "2000000000",
            }] }],
        },
        {
            resource: {
                attributes: [{ key: "service.name", value: { stringValue: "svc-b" } }],
            },
            scopeSpans: [{ spans: [{
                traceId: "t2", spanId: "s2", name: "op2",
                startTimeUnixNano: "3000000000",
                endTimeUnixNano:   "4000000000",
            }] }],
        },
    ],
};

// ─── Span Conversion ───────────────────────────────────────────────────────────

describe("OTLP spanToEvent", () => {
    test("converts a normal span", () => {
        const event = spanToEvent(NORMAL_SPAN, NORMAL_SERVICE);

        expect(event.traceId).toBe("abc123");
        expect(event.service).toBe("api-gateway");
        expect(event.timestamp).toBe(1710000000000);
        expect(event.durationMs).toBeCloseTo(42.5, 1);
        expect(event.isError).toBe(false);
        expect(typeof event.tag).toBe("number");
    });

    test("detects error status (STATUS_CODE_ERROR = 2)", () => {
        const event = spanToEvent(ERROR_SPAN, ERROR_SERVICE);

        expect(event.isError).toBe(true);
        expect(event.durationMs).toBeCloseTo(100.0, 1);
    });

    test("handles missing status (unset = not error)", () => {
        const event = spanToEvent(MISSING_STATUS_SPAN, MISSING_STATUS_SERVICE);

        expect(event.isError).toBe(false);
        expect(event.durationMs).toBeCloseTo(1.0, 1);
    });
});

// ─── Full Payload Conversion ───────────────────────────────────────────────────

describe("OTLP otlpToEvents", () => {
    test("extracts events from full OTLP payload", () => {
        const events = otlpToEvents(FULL_PAYLOAD);

        expect(events.length).toBe(2);
        expect(events[0].service).toBe("user-api");
        expect(events[0].durationMs).toBeCloseTo(50.0, 1);
        expect(events[0].isError).toBe(false);
        expect(events[1].isError).toBe(true);
        expect(events[1].durationMs).toBeCloseTo(25.0, 1);
    });

    test("handles missing resource (defaults to unknown)", () => {
        const events = otlpToEvents(MISSING_RESOURCE_PAYLOAD);

        expect(events.length).toBe(1);
        expect(events[0].service).toBe("unknown");
    });

    test("flattens multiple resource spans", () => {
        const events = otlpToEvents(MULTI_RESOURCE_PAYLOAD);

        expect(events.length).toBe(2);
        expect(events[0].service).toBe("svc-a");
        expect(events[1].service).toBe("svc-b");
    });
});

// ─── Tag Dictionary ───────────────────────────────────────────────────────────

describe("TagDictionary", () => {
    test("assigns unique uint16 IDs", () => {
        const dict = new TagDictionary();
        const id1 = dict.resolve("api-gateway");
        const id2 = dict.resolve("checkout-service");
        const id3 = dict.resolve("api-gateway");

        expect(id1).toBeGreaterThan(0);
        expect(id2).toBeGreaterThan(0);
        expect(id1).not.toBe(id2);
        expect(id3).toBe(id1);
        expect(dict.size).toBe(2);
    });

    test("reverse lookup works", () => {
        const dict = new TagDictionary();
        const id = dict.resolve("payment-service");

        expect(dict.getName(id)).toBe("payment-service");
        expect(dict.getName(99999)).toBeUndefined();
    });

    test("serializes to JSON", () => {
        const dict = new TagDictionary();

        dict.resolve("svc-a");
        dict.resolve("svc-b");
        const json = dict.toJSON();
        expect(json["svc-a"]).toBeDefined();
        expect(json["svc-b"]).toBeDefined();
    });
});

// ─── Protobuf Decoder ─────────────────────────────────────────────────────────

describe("Protobuf decoder", () => {
    test("decodes a minimal protobuf payload", () => {
        const emptyPayload = new Uint8Array(0);
        const result = decodeExportTraceServiceRequest(emptyPayload);

        expect(result).toBeDefined();
        expect(result.resourceSpans).toEqual([]);
    });
});
