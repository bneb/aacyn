/**
 * aacyn SDK — Canonical Telemetry Types
 *
 * These types define the wire format between the C engine (libaacyn) and the
 * TypeScript control plane. Any change here must be mirrored in the
 * native column_store schema.
 */

// ─── Core Event Schema ──────────────────────────────────────────────────────────

export interface TelemetryEvent {
    /** Unique event identifier (UUIDv7 for time-sortability) */
    id: string;
    /** Unix epoch nanoseconds */
    timestamp: number;
    /** Event classification */
    kind: "metric" | "trace" | "log";
    /** Originating service name */
    service: string;
    /** Host identifier */
    host: string;
    /** Arbitrary key-value tags for filtering */
    tags: Record<string, string>;
    /** Metric payload (present when kind === 'metric') */
    metric?: MetricPayload;
    /** Trace/span payload (present when kind === 'trace') */
    trace?: TracePayload;
    /** Log payload (present when kind === 'log') */
    log?: LogPayload;
}

export interface MetricPayload {
    name: string;
    value: number;
    unit: string;
    /** Metric type for aggregation semantics */
    type: "gauge" | "counter" | "histogram";
}

export interface TracePayload {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    operationName: string;
    /** Duration in nanoseconds */
    duration: number;
    status: "ok" | "error";
    /** Structured span attributes */
    attributes: Record<string, unknown>;
}

export interface LogPayload {
    level: "debug" | "info" | "warn" | "error" | "fatal";
    message: string;
    /** Structured log attributes (auto-extracted from unstructured text) */
    attributes: Record<string, unknown>;
}

// ─── RED Metrics (Agent → UEC) ──────────────────────────────────────────────────

export interface RedMetric {
    service: string;
    endpoint: string;
    windowStartNs: number;
    windowDurationNs: number;
    /** Requests per second */
    rate: number;
    /** Error count in window */
    errorCount: number;
    /** Latency percentiles in nanoseconds */
    latency: {
        min: number;
        max: number;
        p50: number;
        p95: number;
        p99: number;
    };
}

// ─── Query Types ────────────────────────────────────────────────────────────────

export interface QueryRequest {
    /** SQL query string */
    sql: string;
    /** Optional time range filter */
    timeRange?: {
        startNs: number;
        endNs: number;
    };
    /** Maximum rows to return */
    limit?: number;
}

export interface QueryResponse {
    columns: string[];
    rows: unknown[][];
    /** Query execution time in nanoseconds */
    durationNs: number;
    /** Total matching rows (before limit) */
    totalRows: number;
}

// ─── API Types ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
    status: "ok" | "degraded" | "down";
    version: string;
    uptime: number;
}
