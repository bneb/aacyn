/**
 * OTLP Protobuf Decoder
 *
 * Decodes OTLP ExportTraceServiceRequest from raw protobuf bytes
 * using protobufjs's programmatic type definitions.
 *
 * We define only the fields we need — this is intentionally minimal.
 * The full OTLP proto has dozens of fields; we extract only:
 *   - resource.attributes (for service.name)
 *   - span.traceId, spanId, name
 *   - span.startTimeUnixNano, endTimeUnixNano
 *   - span.status.code
 */

import * as protobuf from "protobufjs";

// ─── Protobuf Type Definitions (Programmatic) ────────────────────────────────

const root = new protobuf.Root();

// opentelemetry.proto.common.v1
const AnyValue = new protobuf.Type("AnyValue")
    .add(new protobuf.Field("stringValue", 1, "string", "optional"))
    .add(new protobuf.Field("boolValue", 2, "bool", "optional"))
    .add(new protobuf.Field("intValue", 3, "int64", "optional"))
    .add(new protobuf.Field("doubleValue", 4, "double", "optional"))
    .add(new protobuf.Field("bytesValue", 7, "bytes", "optional"));

const KeyValue = new protobuf.Type("KeyValue")
    .add(new protobuf.Field("key", 1, "string"))
    .add(new protobuf.Field("value", 2, "AnyValue"));

KeyValue.add(AnyValue);

const InstrumentationScope = new protobuf.Type("InstrumentationScope")
    .add(new protobuf.Field("name", 1, "string"))
    .add(new protobuf.Field("version", 2, "string"));

// opentelemetry.proto.resource.v1
const Resource = new protobuf.Type("Resource")
    .add(new protobuf.Field("attributes", 1, "KeyValue", "repeated"));

// opentelemetry.proto.trace.v1
const Status = new protobuf.Type("Status")
    .add(new protobuf.Field("message", 2, "string"))
    .add(new protobuf.Field("code", 3, "int32"));

const Span = new protobuf.Type("Span")
    .add(new protobuf.Field("traceId", 1, "bytes"))
    .add(new protobuf.Field("spanId", 2, "bytes"))
    .add(new protobuf.Field("traceState", 3, "string"))
    .add(new protobuf.Field("parentSpanId", 4, "bytes"))
    .add(new protobuf.Field("name", 5, "string"))
    .add(new protobuf.Field("kind", 6, "int32"))
    .add(new protobuf.Field("startTimeUnixNano", 7, "fixed64"))
    .add(new protobuf.Field("endTimeUnixNano", 8, "fixed64"))
    .add(new protobuf.Field("attributes", 9, "KeyValue", "repeated"))
    .add(new protobuf.Field("status", 15, "Status"));

Span.add(Status);

const ScopeSpans = new protobuf.Type("ScopeSpans")
    .add(new protobuf.Field("scope", 1, "InstrumentationScope"))
    .add(new protobuf.Field("spans", 2, "Span", "repeated"));

ScopeSpans.add(InstrumentationScope);
ScopeSpans.add(Span);

const ResourceSpans = new protobuf.Type("ResourceSpans")
    .add(new protobuf.Field("resource", 1, "Resource"))
    .add(new protobuf.Field("scopeSpans", 2, "ScopeSpans", "repeated"));

ResourceSpans.add(Resource);
ResourceSpans.add(ScopeSpans);
ResourceSpans.add(KeyValue);

const ExportTraceServiceRequest = new protobuf.Type("ExportTraceServiceRequest")
    .add(new protobuf.Field("resourceSpans", 1, "ResourceSpans", "repeated"));

ExportTraceServiceRequest.add(ResourceSpans);

root.add(ExportTraceServiceRequest);

// ─── Decoded Payload Types ────────────────────────────────────────────────────
// These match the shape protobufjs toObject() produces with longs=String,
// bytes=String, defaults=true -- the same structure DecodedExportTraceServiceRequest
// in otlp.ts describes, defined here to avoid a circular import.

interface DecodedStatus {
    message?: string;
    code?: number;
}

interface DecodedSpan {
    traceId?: string | Uint8Array;
    spanId?: string | Uint8Array;
    name?: string;
    kind?: number;
    startTimeUnixNano?: string;
    endTimeUnixNano?: string;
    status?: DecodedStatus;
}

interface DecodedScopeSpans {
    scope?: { name?: string; version?: string };
    spans?: DecodedSpan[];
}

interface DecodedResourceSpans {
    resource?: { attributes?: Array<{ key?: string; value?: Record<string, unknown> }> };
    scopeSpans?: DecodedScopeSpans[];
}

interface DecodedExportTraceServiceRequest {
    resourceSpans?: DecodedResourceSpans[];
}

// ─── Decoder ─────────────────────────────────────────────────────────────────

/**
 * Decode raw protobuf bytes into an OTLP-like JSON structure
 * that matches our existing OtlpSpan/OtlpResourceSpans types.
 */
export function decodeExportTraceServiceRequest(buffer: Uint8Array): DecodedExportTraceServiceRequest {
    const message = ExportTraceServiceRequest.decode(buffer);
    const obj = ExportTraceServiceRequest.toObject(message, {
        longs: String,    // uint64 as string (matches JSON OTLP format)
        bytes: String,    // bytes as hex string
        defaults: true,
    });
    return obj as DecodedExportTraceServiceRequest;
}

/**
 * Convert protobuf bytes trace/span IDs (Uint8Array) to hex strings.
 * Handles both Buffer and base64-encoded string representations.
 */
export function bytesToHex(val: string | Uint8Array | Buffer | null | undefined): string {
    if (!val) return "";
    if (typeof val === "string") {
        // protobufjs returns base64 by default when bytes: String
        return Buffer.from(val, "base64").toString("hex");
    }
    if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
        return Buffer.from(val).toString("hex");
    }
    return String(val);
}
