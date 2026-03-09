/**
 * OTLP Native Ingestion — POST /v1/traces
 *
 * Accepts standard OpenTelemetry OTLP/HTTP trace data and converts
 * it to aacyn's columnar format for insertion into the native store.
 *
 * Supports:
 *   - OTLP/HTTP JSON    (Content-Type: application/json)
 *   - OTLP/HTTP Proto   (Content-Type: application/x-protobuf)
 *
 * OTLP trace structure:
 *   ExportTraceServiceRequest → ResourceSpans[] → ScopeSpans[] → Spans[]
 *
 * Each span maps to one aacyn event:
 *   - timestamp  = Math.floor(startTimeUnixNano / 1_000_000)  (milliseconds)
 *   - durationMs = (endTimeUnixNano - startTimeUnixNano) / 1_000_000
 *   - isError    = status.code === STATUS_CODE_ERROR (2)
 *   - traceId    = hex-encoded trace ID
 *   - service    = resource.attributes["service.name"]
 *   - tag        = uint16 from TagDictionary (service name → compact ID)
 *
 * Standard OTel SDK config to point at aacyn:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3001
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json     (or http/protobuf)
 */

import { Elysia } from "elysia";
import { withStore } from "../lib/store-init";
import { decodeExportTraceServiceRequest, bytesToHex } from "../lib/otlp-decode";
import { createLogger } from "../lib/logger";
const log = createLogger("routes-otlp");



// ─── Tag Dictionary ──────────────────────────────────────────────────────────
/**
 * Fast string-to-uint16 dictionary for service/span names.
 * Assigns a unique uint16 ID to each new string, caching it.
 * Max 65535 unique tags — more than enough for service names.
 */
export class TagDictionary {
    private readonly map = new Map<string, number>();
    private nextId = 1; // 0 reserved for "unknown"

    /** Get or assign a uint16 ID for a string. */
    resolve(name: string): number {
        const existing = this.map.get(name);
        if (existing !== undefined) return existing;

        if (this.nextId > 0xffff) {
            log.warn(`[otlp] Tag dictionary full (65535 tags). Reusing ID 0 for: ${name}`);
            return 0;
        }

        const id = this.nextId++;
        this.map.set(name, id);
        return id;
    }

    /** Reverse lookup: ID → name. */
    getName(id: number): string | undefined {
        for (const [name, tagId] of this.map) {
            if (tagId === id) return name;
        }
        return undefined;
    }

    get size(): number {
        return this.map.size;
    }

    /** Dump the dictionary (for debugging/inspection). */
    toJSON(): Record<string, number> {
        return Object.fromEntries(this.map);
    }
}

// Singleton tag dictionary
export const tagDictionary = new TagDictionary();

// ─── OTLP Types ──────────────────────────────────────────────────────────────

/** Minimal OTLP types — only what we need for span conversion. */

interface OtlpKeyValue {
    key: string;
    value: {
        stringValue?: string;
        intValue?: string | number;
        doubleValue?: number;
        boolValue?: boolean;
    };
}

interface OtlpResource {
    attributes?: OtlpKeyValue[];
}

interface OtlpStatus {
    code?: number;  // 0 = UNSET, 1 = OK, 2 = ERROR
    message?: string;
}

interface OtlpSpan {
    traceId: string;
    spanId: string;
    name: string;
    kind?: number;
    startTimeUnixNano: string;  // uint64 as string in JSON
    endTimeUnixNano: string;
    status?: OtlpStatus;
    attributes?: OtlpKeyValue[];
}

interface OtlpScopeSpans {
    scope?: { name?: string; version?: string };
    spans: OtlpSpan[];
}

interface OtlpResourceSpans {
    resource?: OtlpResource;
    scopeSpans: OtlpScopeSpans[];
}

interface ExportTraceServiceRequest {
    resourceSpans: OtlpResourceSpans[];
}

/** Types for protobuf-decoded spans before normalization. */
interface DecodedSpan {
    traceId?: string | Uint8Array;
    spanId?: string | Uint8Array;
    name?: string;
    kind?: number;
    startTimeUnixNano?: string | number;
    endTimeUnixNano?: string | number;
    status?: { message?: string; code?: number };
    attributes?: OtlpKeyValue[];
}

interface DecodedScopeSpans {
    scope?: { name?: string; version?: string };
    spans?: DecodedSpan[];
}

interface DecodedResourceSpans {
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: DecodedScopeSpans[];
}

/** Shape returned by decodeExportTraceServiceRequest before normalization. */
interface DecodedExportTraceServiceRequest {
    resourceSpans?: DecodedResourceSpans[];
}

// ─── Span → aacyn Event Converter ────────────────────────────────────────────

const STATUS_CODE_ERROR = 2;

interface AacynEvent {
    traceId: string;
    service: string;
    durationMs: number;
    isError: boolean;
    timestamp: number;
    tag?: number;
}

/**
 * Extract the service name from OTLP resource attributes.
 */
function extractServiceName(resource?: OtlpResource): string {
    if (!resource?.attributes) return "unknown";
    for (const attr of resource.attributes) {
        if (attr.key === "service.name" && attr.value.stringValue) {
            return attr.value.stringValue;
        }
    }
    return "unknown";
}

/**
 * Convert a single OTLP span to an aacyn event.
 */
export function spanToEvent(span: OtlpSpan, serviceName: string): AacynEvent {
    const startNano = BigInt(span.startTimeUnixNano);
    const endNano = BigInt(span.endTimeUnixNano);
    const durationNano = endNano - startNano;
    const durationMs = Number(durationNano) / 1_000_000;

    return {
        traceId: span.traceId,
        service: serviceName,
        durationMs,
        isError: span.status?.code === STATUS_CODE_ERROR,
        timestamp: Number(startNano / 1_000_000n), // milliseconds for the store
        tag: tagDictionary.resolve(serviceName),
    };
}

/**
 * Convert an OTLP ExportTraceServiceRequest into aacyn events.
 */
export function otlpToEvents(request: ExportTraceServiceRequest): AacynEvent[] {
    const events: AacynEvent[] = [];

    for (const rs of request.resourceSpans) {
        const serviceName = extractServiceName(rs.resource);
        for (const ss of rs.scopeSpans) {
            for (const span of ss.spans) {
                events.push(spanToEvent(span, serviceName));
            }
        }
    }

    return events;
}

// ─── Body Parsing ────────────────────────────────────────────────────────────

interface ParseResult {
    body?: ExportTraceServiceRequest;
    error?: { status: number; response: Record<string, unknown> };
}

/**
 * Parse the request body based on Content-Type.
 * Returns the parsed body on success, or error details on failure.
 */
async function tryParseOtlpBody(contentType: string, request: Request): Promise<ParseResult> {
    if (contentType.includes("application/json")) {
        try {
            const body = (await request.json()) as ExportTraceServiceRequest;
            return { body };
        } catch (e) {
            log.error({ error: (e as Error).message }, "OTLP: failed to parse JSON body");
            return { error: { status: 400, response: { error: "Invalid JSON payload. Expected an ExportTraceServiceRequest with resourceSpans array. Example: {\"resourceSpans\": [{\"resource\": {\"attributes\": [{\"key\": \"service.name\", \"value\": {\"stringValue\": \"my-service\"}}]}, \"scopeSpans\": [{\"spans\": [...]}]}]}" } } };
        }
    }
    if (contentType.includes("application/x-protobuf")) {
        try {
            const rawBuffer = await request.arrayBuffer();
            const decoded = decodeExportTraceServiceRequest(new Uint8Array(rawBuffer)) as DecodedExportTraceServiceRequest;
            return { body: normalizeProtobufPayload(decoded) };
        } catch (err) {
            return { error: { status: 400, response: { error: `Failed to decode protobuf: ${(err as Error).message}` } } };
        }
    }
    return { error: { status: 415, response: { error: `Unsupported Content-Type: ${contentType}`, hint: "Use application/json or application/x-protobuf" } } };
}

/**
 * Build the ingest response and log the result.
 */
function buildIngestResponse(accepted: number, total: number, resourceCount: number, isProto: boolean) {
    log.info(
        `[otlp] Ingested ${accepted}/${total} spans from ` +
        `${resourceCount} resource(s) ` +
        `[${isProto ? "proto" : "json"}]`
    );
    return {
        partialSuccess: {
            rejectedSpans: total - accepted,
            errorMessage: accepted < total
                ? "Some spans were dropped due to store capacity"
                : undefined,
        },
    };
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const otlpRoutes = new Elysia()
    .use(withStore)
    /**
     * OTLP HTTP/JSON and HTTP/Protobuf Trace Ingestion
     *
     * Accepts both JSON and Protobuf content types.
     */
    .post("/v1/traces", async ({ request, set, store }) => {
        const contentType = request.headers.get("content-type") ?? "";
        const parsed = await tryParseOtlpBody(contentType, request);
        if (parsed.error) {
            set.status = parsed.error.status;
            return parsed.error.response;
        }
        const body = parsed.body!;
        if (!body?.resourceSpans || !Array.isArray(body.resourceSpans)) {
            set.status = 400;
            return { error: "Invalid OTLP payload: missing resourceSpans" };
        }
        const events = otlpToEvents(body);
        if (events.length === 0) {
            set.status = 200;
            return { partialSuccess: { rejectedSpans: 0 } };
        }
        const accepted = store.ingestBatch(events);
        set.status = 200;
        return buildIngestResponse(
            accepted,
            events.length,
            body.resourceSpans.length,
            contentType.includes("protobuf"),
        );
    })

    /**
     * Tag dictionary introspection (for debugging)
     */
    .get("/v1/tags", () => ({
        tags: tagDictionary.toJSON(),
        count: tagDictionary.size,
    }))

    /**
     * Health check for OTel collectors
     */
    .get("/v1/traces", ({ set }) => {
        set.status = 200;
        return { status: "aacyn OTLP receiver ready" };
    });

// ─── Protobuf Normalization ──────────────────────────────────────────────────

/**
 * Normalize protobuf decoded output to match the JSON OTLP format.
 * Protobuf uses bytes for trace/span IDs and fixed64 for timestamps,
 * which need to be converted to hex strings and string numbers.
 */
function normalizeProtobufPayload(decoded: DecodedExportTraceServiceRequest): ExportTraceServiceRequest {
    if (!decoded?.resourceSpans) {
        return { resourceSpans: [] };
    }

    return {
        resourceSpans: decoded.resourceSpans.map((rs: DecodedResourceSpans) => ({
            resource: rs.resource,
            scopeSpans: (rs.scopeSpans || []).map((ss: DecodedScopeSpans) => ({
                scope: ss.scope,
                spans: (ss.spans || []).map((span: DecodedSpan) => ({
                    traceId: bytesToHex(span.traceId),
                    spanId: bytesToHex(span.spanId),
                    name: span.name || "",
                    kind: span.kind || 0,
                    startTimeUnixNano: String(span.startTimeUnixNano || "0"),
                    endTimeUnixNano: String(span.endTimeUnixNano || "0"),
                    status: span.status || { code: 0 },
                    attributes: span.attributes || [],
                })),
            })),
        })),
    };
}
