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

// ─── Store Interface (Sprint 4: Type Safety) ─────────────────────────────────

/** Unsupported operation error — thrown when the store backend can't support a method. */
export class UnsupportedError extends Error {
    constructor(operation: string, backend: string) {
        super(
            `"${operation}" is not available on the "${backend}" backend. ` +
            `This feature requires the native libaacyn engine. ` +
            `Fix: build the native engine with "cd native && make && sudo make install" ` +
            `or set LIBAACYN_PATH to point to your libaacyn.dylib/libaacyn.so.`
        );
        this.name = "UnsupportedError";
    }
}

export interface TopologyEdge {
    source: string;
    target: string;
    sourceIp: string;
    destIp: string;
    destPort: number;
    hitCount: number;
    avgLatencyUs: number;
    lastSeenNs: number;
    totalBytes: number;
    errorCount: number;
    retransmitCount?: number;
    containerId?: string;
    /** Pod name for the source endpoint (enriched by K8sDiscovery) */
    sourcePodName?: string;
    /** Namespace of the source pod */
    sourcePodNamespace?: string;
    /** Deployment name for the source pod */
    sourceDeployment?: string;
    /** Pod name for the target endpoint */
    targetPodName?: string;
    /** Namespace of the target pod */
    targetPodNamespace?: string;
    /** Deployment name for the target pod */
    targetDeployment?: string;
    /** gRPC service:method detected on this edge (e.g. "helloworld.Greeter:SayHello") */
    grpcService?: string;
}

export interface DiscoveredService {
    pid: number;
    port: number;
    comm: string;
    acceptCount: number;
    avgLatencyMs: number;
    lastSeenNs: number;
    /** Pod name (enriched by K8sDiscovery) */
    podName?: string;
    /** Namespace of the pod */
    podNamespace?: string;
    /** Deployment name for the pod */
    deployment?: string;
}

export interface GoldenSignal {
    service: string;
    rate: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    throughputKbps: number;
    /** HTTP request rate (requests per second) */
    httpRateRps?: number;
    /** HTTP error percentage (5xx / total * 100) */
    httpErrorPct?: number;
    /** HTTP 2xx status count in the window */
    http2xx?: number;
    /** HTTP 3xx status count in the window */
    http3xx?: number;
    /** HTTP 4xx status count in the window */
    http4xx?: number;
    /** HTTP 5xx status count in the window */
    http5xx?: number;
    /** Sparkline data — last N request-rate data points for inline mini-chart */
    sparkline?: number[];
}

// ─── Trace Types ──────────────────────────────────────────────────────

export interface SpanNode {
    spanId: string;
    parentSpanId: string | null;
    service: string;
    durationMs: number;
    isError: boolean;
    timestamp: number;
    method?: string;
    statusCode?: number;
    path?: string;
    children: SpanNode[];
}

export interface TraceTreeResponse {
    traceId: string;
    totalDurationMs: number;
    spanCount: number;
    spans: SpanNode[];
}

/**
 * IStore — canonical store interface implemented by both NativeStore (FFI→C)
 * and V8MapStore (pure TypeScript fallback). All route handlers consume this
 * interface rather than accessing store methods via `as any`.
 */
export interface IStore {
    // Ingestion
    ingestBatch(events: { traceId: string; service: string; durationMs: number; isError: boolean; timestamp: number }[]): number;
    ingestBinary(buffer: ArrayBuffer): number;

    // Query
    query(opts: { startNs?: number; endNs?: number; errorOnly?: boolean; limit?: number }): { timestamp: number; duration: number; isError: boolean }[];
    getByTraceId(traceId: string): { traceId: string; service: string; durationMs: number; isError: boolean; timestamp: number } | undefined;

    // Metadata
    readonly count: number;
    readonly size: number;
    clear(): void;

    // SIMD scans (native only — throws UnsupportedError on V8MapStore)
    scanDurationMax(): number;
    scanErrorCount(): number;

    // Filter rules
    setRules(ruleBuffer: Uint8Array, count: number): void;
    eventsDropped(): number;

    // Memory
    byteSize(): number;
    nativeLen(): number;
    head(): number;

    // Archiver support
    extractRaw(fromHead: number, count: number): { buffer: Buffer; extracted: number };

    // eBPF
    ebpfAttach(bpfObjPath: string): number;
    ebpfPoll(timeoutMs?: number): number;
    ebpfDetach(): void;
    ebpfDrainCount(): number;
    dropCounts(): { standard: number; critical: number };

    // Discovery
    discoveredServices(): DiscoveredService[];
    topologyEdges(): TopologyEdge[];

    // Trace span queries
    getTraceSpans?(traceId: string): { traceId: string; spanId?: string; parentSpanId?: string; service: string; durationMs: number; isError: boolean; timestamp: number; path?: string; method?: string; statusCode?: number }[] | undefined;
    drainTraceSpans(): number;
    sync(): void;
    destroy(): void;
}
