/**
 * Native Columnar Store — Bun FFI Bridge
 *
 * Wraps libaacyn.c via bun:ffi dlopen. All memory lives outside
 * the V8/JSC heap in mmap'd page-aligned regions. Zero GC pressure.
 *
 * Usage:
 *   import { NativeStore } from "./native-store";
 *   const store = new NativeStore(1_000_000);
 *   store.batchInsert(timestamps, durations, errors);
 */

import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi";
import { join, dirname } from "path";
import { createLogger } from "./logger";
import type { IStore } from "@aacyn/sdk";
const log = createLogger("lib-native-store");

// ─── Load Native Library ─────────────────────────────────────────────────────
// In development: resolve relative to source tree via __dirname traversal.
// In compiled binary (bun build --compile): use LIBAACYN_PATH env var
// or look for the .so/.dylib co-located with the binary.
const LIB_PATH = process.env.LIBAACYN_PATH || (() => {
    // Try co-located first (production: binary + lib in same dir)
    const colocated = join(dirname(process.execPath), `libaacyn.${suffix}`);
    try {
        if (require("fs").existsSync(colocated)) return colocated;
    } catch (err) {
        log.warn("[libaacyn] Cannot check colocated lib path: " + (err as Error).message);
    }
    // Development: traverse from source tree
    return join(
        dirname(dirname(dirname(dirname(dirname(__dirname))))),
        "build",
        `libaacyn.${suffix}`
    );
})();

const { symbols } = dlopen(LIB_PATH, {
    aacyn_store_create: {
        args: [FFIType.u64],
        returns: FFIType.ptr,
    },
    aacyn_store_open: {
        args: [FFIType.cstring, FFIType.u64],
        returns: FFIType.ptr,
    },
    aacyn_store_batch_insert: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.u64,
    },
    aacyn_store_ingest_flatbuf: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.u64,
    },
    aacyn_store_len: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_capacity: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_byte_size: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_head: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_sync: {
        args: [FFIType.ptr],
        returns: FFIType.void,
    },
    aacyn_store_scan: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u64],
        returns: FFIType.u64,
    },
    aacyn_store_extract_raw: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_set_rules: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.void,
    },
    aacyn_store_get_events_dropped: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_scan_duration_max: {
        args: [FFIType.ptr],
        returns: FFIType.f32,
    },
    aacyn_store_scan_error_count: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_ebpf_attach: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.i32,
    },
    aacyn_ebpf_poll: {
        args: [FFIType.i32],
        returns: FFIType.i32,
    },
    aacyn_ebpf_detach: {
        args: [],
        returns: FFIType.void,
    },
    aacyn_ebpf_drain_count: {
        args: [],
        returns: FFIType.u64,
    },
    aacyn_get_drop_counts: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.void,
    },
    aacyn_discovery_register: {
        args: [FFIType.u32, FFIType.u16, FFIType.ptr, FFIType.u64],
        returns: FFIType.void,
    },
    aacyn_discovery_count: {
        args: [],
        returns: FFIType.u32,
    },
    aacyn_discovery_get: {
        args: [FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
    },
    aacyn_topology_count: {
        args: [],
        returns: FFIType.u32,
    },
    aacyn_topology_get: {
        args: [FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
    },
    aacyn_store_destroy: {
        args: [FFIType.ptr],
        returns: FFIType.void,
    },
    aacyn_trace_span_count: {
        args: [],
        returns: FFIType.u32,
    },
    aacyn_trace_span_get: {
        args: [FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
    },
});

// ─── TypeScript Wrapper ──────────────────────────────────────────────────────

export interface IngestEvent {
    traceId: string;
    spanId?: string;
    parentSpanId?: string;
    service: string;
    durationMs: number;
    isError: boolean;
    timestamp: number;
    path?: string;
    method?: string;
    statusCode?: number;
}

export interface ServiceRecord {
    pid: number;
    port: number;
    comm: string;
    acceptCount: number;
    avgLatencyMs: number;
    lastSeenNs: number;
}

export interface TopologyEdge {
    source: string;
    target: string;
    containerId: string;
    sourceIp: string;
    destIp: string;
    destPort: number;
    hitCount: number;
    avgLatencyUs: number;
    lastSeenNs: number;
    totalBytes: number;
    errorCount: number;
    retransmitCount: number;
    grpcService?: string;
}

/**
 * NativeStore — Zero-copy columnar store backed by mmap'd memory.
 *
 * Events are shredded from JSON into typed arrays on the JS side,
 * then the typed array backing buffers are passed directly to C
 * via bun:ffi pointers. No V8 heap allocation for the data columns.
 */
export class NativeStore implements IStore {
    private handle: Pointer;

    // Keep a trace span index in JS for O(1) lookups by traceId.
    // Maps traceId → array of spans (multiple spans per trace for tree building).
    private readonly traceIndex = new Map<string, IngestEvent[]>();
    private _count = 0;
    private lastDrops = { standard: 0, critical: 0 };
    private dropPoller?: ReturnType<typeof setInterval>;
    constructor(capacityOrOpts: number | { path: string; capacity: number }) {
        if (typeof capacityOrOpts === "object") {
            this.handle = this.initPersistentStore(capacityOrOpts.path, capacityOrOpts.capacity);
        } else {
            this.handle = this.initAnonymousStore(capacityOrOpts);
        }
        this.startDropPolling();
    }

    private initPersistentStore(path: string, capacity: number): Pointer {
        const encoder = new TextEncoder();
        const pathBytes = encoder.encode(path + "\0");
        const h = symbols.aacyn_store_open(ptr(pathBytes), capacity);
        if (!h) throw new Error(
            `[libaacyn] Failed to open persistent store at "${path}". ` +
            `The C engine returned a null handle — the path may not exist, the file may be corrupt, ` +
            `or the system may have insufficient memory. ` +
            `Check: (1) does the directory exist? mkdir -p "$(dirname "${path}")" ` +
            `(2) is there enough free memory? The store needs ~${(capacity * 13 / 1024 / 1024).toFixed(1)}MB ` +
            `(3) try deleting the file and restarting.`
        );
        const handle = h as Pointer;
        this._count = Number(symbols.aacyn_store_len(handle));

        process.on("SIGTERM", () => {
            log.info("[libaacyn] SIGTERM received — syncing store to disk...");
            this.sync();
            process.exit(0);
        });

        log.info(
            `[\u{1F6E1}\u{FE0F} libaacyn] Persistent store: ${capacity.toLocaleString()} capacity, ` +
            `${(Number(symbols.aacyn_store_byte_size(handle)) / 1024 / 1024).toFixed(1)}MB mmap'd, ` +
            `head=${Number(symbols.aacyn_store_head(handle))}, count=${this._count}`
        );
        return handle;
    }

    private initAnonymousStore(capacity: number): Pointer {
        const h = symbols.aacyn_store_create(capacity);
        if (!h) throw new Error(
            `[libaacyn] Failed to create native store via dlopen of "${LIB_PATH}". ` +
            `The C engine returned a null handle. ` +
            `Check: (1) does the library exist at ${LIB_PATH}? ` +
            `(2) build it: cd native && make && sudo make install ` +
            `(3) override the path: export LIBAACYN_PATH=/path/to/libaacyn.dylib ` +
            `(4) is there enough free memory? The store needs ~${(capacity * 13 / 1024 / 1024).toFixed(1)}MB.`
        );
        const handle = h as Pointer;
        log.info(
            `[\u{1F6E1}\u{FE0F} libaacyn] Native store initialized: ${capacity.toLocaleString()} capacity, ` +
            `${(Number(symbols.aacyn_store_byte_size(handle)) / 1024 / 1024).toFixed(1)}MB mmap'd`
        );
        return handle;
    }

    private startDropPolling(): void {
        this.dropPoller = setInterval(() => {
            const drops = this.dropCounts();
            if (drops.standard > this.lastDrops.standard || drops.critical > this.lastDrops.critical) {
                const diffStd = drops.standard - this.lastDrops.standard;
                const diffCrit = drops.critical - this.lastDrops.critical;
                log.warn(`[\u{1F52C} eBPF] Ring buffer dropped ${diffStd} standard, ${diffCrit} critical events`);
                this.lastDrops = drops;
            }

            try {
                const { metrics } = require("./metrics") as { metrics: typeof import("./metrics").metrics };
                metrics.gauge("ebpf_ring_buffer_drops_total", drops.standard, { severity: "standard" });
                metrics.gauge("ebpf_ring_buffer_drops_total", drops.critical, { severity: "critical" });
            } catch (e) {
                log.warn("[libaacyn] Metrics not available for drop reporting: " + (e as Error).message);
            }
        }, 10_000);
        if (this.dropPoller.unref) this.dropPoller.unref();
    }

    /**
     * Ingest a batch of events.
     *
     * 1. Shred JSON objects → typed arrays (minimal JS-side work)
     * 2. Pass typed array pointers to C via FFI (zero-copy)
     * 3. C does memcpy into mmap'd SoA columns
     */
    ingestBatch(events: IngestEvent[]): number {
        const count = events.length;

        // Shred JSON → typed arrays
        const timestamps = new BigUint64Array(count);
        const durations = new Float32Array(count);
        const isErrors = new Uint8Array(count);

        for (let i = 0; i < count; i++) {
            const e = events[i];
            timestamps[i] = BigInt(e.timestamp);
            durations[i] = e.durationMs;
            isErrors[i] = e.isError ? 1 : 0;

            // Index spans by traceId for tree queries
            const indexed = { ...e };
            if (!indexed.spanId) {
                indexed.spanId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
            }
            const spans = this.traceIndex.get(indexed.traceId) || [];
            spans.push(indexed);
            this.traceIndex.set(indexed.traceId, spans);
        }

        // FFI call: pass typed array backing buffer pointers directly to C
        const inserted = Number(symbols.aacyn_store_batch_insert(
            this.handle,
            ptr(timestamps),
            ptr(durations),
            ptr(isErrors),
            count
        ));

        this._count += inserted;
        return inserted;
    }

    /** O(1) trace lookup — returns the first span for backward compat. */
    getByTraceId(traceId: string): IngestEvent | undefined {
        const spans = this.traceIndex.get(traceId);
        return spans ? spans[0] : undefined;
    }

    /** Return all spans for a trace ID (for span tree building). */
    getTraceSpans(traceId: string): IngestEvent[] | undefined {
        return this.traceIndex.get(traceId);
    }

    /** Poll C buffer for eBPF trace spans and add them to the trace index. */
    drainTraceSpans(): number {
        const count = Number(symbols.aacyn_trace_span_count());
        if (count === 0) return 0;

        const SPAN_SIZE = 86; // bytes per trace span record in C (aacyn_trace_span_t, packed: 8+16+8+8+4+2+2+1+1+4+16+8+1+7)
        const buf = Buffer.alloc(SPAN_SIZE);
        let drained = 0;

        for (let i = 0; i < count; i++) {
            const ok = symbols.aacyn_trace_span_get(i, ptr(buf));
            if (!ok) continue;
            drained++;

            const span = this.readTraceSpan(buf);
            if (!span) continue;

            const spans = this.traceIndex.get(span.traceId) || [];
            spans.push(span);
            this.traceIndex.set(span.traceId, spans);
        }

        return drained;
    }

    get count(): number {
        return this._count;
    }

    get size(): number {
        return this.traceIndex.size;
    }

    /** SIMD-accelerated max duration scan. */
    scanDurationMax(): number {
        return symbols.aacyn_store_scan_duration_max(this.handle) as number;
    }

    /** SIMD-accelerated error count. */
    scanErrorCount(): number {
        return Number(symbols.aacyn_store_scan_error_count(this.handle));
    }

    /**
     * Query the ring buffer with filters. Returns matching events.
     *
     * Zero-copy extraction: allocates a contiguous output buffer,
     * passes its pointer to C, C writes matching events directly,
     * then TypeScript reads the buffer via DataView. No JS object
     * allocation on the hot path.
     *
     * Each event in the output buffer is 20 bytes:
     *   [0..7]  uint64  timestamp
     *   [8..11] float32 duration_ms
     *   [12..15] uint32 is_error
     *   [16..19] uint32 padding
     */
    query(opts: {
        startNs?: number;
        endNs?: number;
        errorOnly?: boolean;
        limit?: number;
    } = {}): { timestamp: number; duration: number; isError: boolean }[] {
        const limit = Math.min(opts.limit ?? 50000, 100000);
        const EVENT_SIZE = 20; // bytes per event in the output buffer

        // Allocate output buffer
        const buf = Buffer.allocUnsafe(limit * EVENT_SIZE);

        // Call C scan
        const found = Number(symbols.aacyn_store_scan(
            this.handle,
            opts.startNs ?? 0,
            opts.endNs ?? 0,
            opts.errorOnly ? 1 : 0,
            ptr(buf),
            limit
        ));

        // Read events from buffer via DataView (zero-copy)
        const results: { timestamp: number; duration: number; isError: boolean }[] = [];
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        for (let i = 0; i < found; i++) {
            const offset = i * EVENT_SIZE;
            // Read uint64 timestamp as two uint32s (little-endian)
            const tsLow = view.getUint32(offset, true);
            const tsHigh = view.getUint32(offset + 4, true);
            const timestamp = tsLow + tsHigh * 0x100000000;

            const duration = view.getFloat32(offset + 8, true);
            const isError = view.getUint32(offset + 12, true) !== 0;

            results.push({ timestamp, duration, isError });
        }

        return results;
    }

    /**
     * Extract raw columnar bytes from the ring buffer by head index range.
     * Used by the archiver for zero-copy chunk extraction before compression.
     *
     * Output layout: [timestamps: n*8B][durations: n*4B][is_errors: n*1B]
     * Total: n * 13 bytes.
     *
     * The C function handles wrap-around internally.
     */
    extractRaw(fromHead: number, count: number): { buffer: Buffer; extracted: number } {
        const BYTES_PER_EVENT = 13; // 8 + 4 + 1
        const buf = Buffer.allocUnsafe(count * BYTES_PER_EVENT);

        const extracted = Number(symbols.aacyn_store_extract_raw(
            this.handle,
            fromHead,
            count,
            ptr(buf)
        ));

        return {
            buffer: extracted < count ? buf.subarray(0, extracted * BYTES_PER_EVENT) : buf,
            extracted,
        };
    }

    /**
     * Set declarative filter rules compiled from aacyn.toml.
     * Accepts a packed Uint8Array of 16-byte rule structs.
     */
    setRules(ruleBuffer: Uint8Array, count: number): void {
        if (count === 0) return;
        if (ruleBuffer.length < count * 16) {
            throw new Error(`Rule buffer too small: ${ruleBuffer.length} bytes for ${count} rules (need ${count * 16})`);
        }
        const buf = Buffer.from(ruleBuffer);
        symbols.aacyn_store_set_rules(this.handle, ptr(buf), count);
    }

    /** Number of events dropped by filter rules. */
    eventsDropped(): number {
        return Number(symbols.aacyn_store_get_events_dropped(this.handle));
    }

    /** Native memory footprint (not in V8 heap). */
    byteSize(): number {
        return Number(symbols.aacyn_store_byte_size(this.handle));
    }

    /** Total records in columnar store. */
    nativeLen(): number {
        return Number(symbols.aacyn_store_len(this.handle));
    }

    /** Monotonic head pointer (for ring buffer). */
    head(): number {
        return Number(symbols.aacyn_store_head(this.handle));
    }

    /** Force sync all dirty pages to disk (for graceful shutdown). */
    sync(): void {
        symbols.aacyn_store_sync(this.handle);
    }

    /**
     * Ingest a FlatBuffer binary payload directly — ZERO parsing.
     *
     * The raw binary buffer is passed to C via a pointer.
     * C reads the FlatBuffer offsets and shreds inline EventStructs
     * into the SoA columns. No JSON, no TypeBox, no V8 GC.
     */
    ingestBinary(buffer: ArrayBuffer): number {
        const bytes = new Uint8Array(buffer);
        const ingested = Number(symbols.aacyn_store_ingest_flatbuf(
            this.handle,
            ptr(bytes),
            bytes.byteLength
        ));
        this._count += ingested;
        return ingested;
    }

    /** Attempt to attach eBPF probes (Linux only). Returns 0 on success. */
    ebpfAttach(bpfObjPath: string): number {
        const encoder = new TextEncoder();
        const pathBytes = encoder.encode(bpfObjPath + "\0");
        return symbols.aacyn_ebpf_attach(this.handle, ptr(pathBytes)) as number;
    }

    /** Poll eBPF ring buffer for new events. */
    ebpfPoll(timeoutMs: number = 100): number {
        return symbols.aacyn_ebpf_poll(timeoutMs) as number;
    }

    /** Detach eBPF probes. */
    ebpfDetach(): void {
        symbols.aacyn_ebpf_detach();
    }

    /** Total eBPF ring buffer events consumed. */
    ebpfDrainCount(): number {
        return Number(symbols.aacyn_ebpf_drain_count());
    }

    /**
     * V2: Read observable backpressure counters.
     * Aggregates Per-CPU drop values from the kernel's drop_counters map.
     */
    dropCounts(): { standard: number; critical: number } {
        const stdBuf = new BigUint64Array(1);
        const critBuf = new BigUint64Array(1);
        symbols.aacyn_get_drop_counts(ptr(stdBuf), ptr(critBuf));
        return {
            standard: Number(stdBuf[0]),
            critical: Number(critBuf[0]),
        };
    }

    /**
     * Get all auto-discovered services from the eBPF registry.
     * Returns an array of service records with golden signal metrics.
     */
    discoveredServices(): ServiceRecord[] {
        const count = Number(symbols.aacyn_discovery_count());
        if (count === 0) return [];

        const RECORD_SIZE = 56;
        const buf = Buffer.alloc(RECORD_SIZE);
        const services: ServiceRecord[] = [];

        for (let i = 0; i < count; i++) {
            const ok = symbols.aacyn_discovery_get(i, ptr(buf));
            if (!ok) continue;
            services.push(this.readServiceRecord(buf));
        }

        return services;
    }

    /**
     * Get all topology edges from the eBPF ring buffer.
     * Each edge represents a source_comm → dest_ip:dest_port connection.
     */
    topologyEdges(): TopologyEdge[] {
        const count = Number(symbols.aacyn_topology_count());
        if (count === 0) return [];

        const RECORD_SIZE = 128;
        const buf = Buffer.alloc(RECORD_SIZE);
        const edges: TopologyEdge[] = [];

        // Port → friendly name for display (doesn't affect merge logic)
        const portNames: Record<number, string> = {
            80: "frontend (nginx)",
            3000: "api (node)",
            5432: "db (postgres)",
            3001: "aacyn-sidecar",
            4318: "otlp-collector",
        };

        for (let i = 0; i < count; i++) {
            const ok = symbols.aacyn_topology_get(i, ptr(buf));
            if (!ok) continue;
            edges.push(this.readTopologyEdge(buf, portNames));
        }

        this.mergeSubgraphs(edges);
        return edges;
    }

    clear(): void {
        // Destroy and recreate
        const cap = Number(symbols.aacyn_store_capacity(this.handle));
        symbols.aacyn_store_destroy(this.handle);
        const newHandle = symbols.aacyn_store_create(cap);
        if (!newHandle) {
            throw new Error("[libaacyn] Failed to recreate native store during clear() — system may be out of memory");
        }
        this.handle = newHandle as Pointer;
        this.traceIndex.clear();
        this._count = 0;
    }

    destroy(): void {
        symbols.aacyn_store_destroy(this.handle);
        this.traceIndex.clear();
        this._count = 0;
    }

    // ── Private Helpers ───────────────────────────────────────────────────────

    private readCString(buf: Buffer, offset: number, maxLen: number): string {
        let result = "";
        for (let i = 0; i < maxLen; i++) {
            const c = buf[offset + i];
            if (c === 0) break;
            result += String.fromCharCode(c);
        }
        return result;
    }

    private readServiceRecord(buf: Buffer): ServiceRecord {
        const view = new DataView(buf.buffer);
        const pid = view.getUint32(0, true);
        const port = view.getUint16(4, true);
        const comm = this.readCString(buf, 6, 16);
        const acceptCount = Number(view.getBigUint64(24, true));
        const totalLatency = Number(view.getBigUint64(32, true));
        const lastSeenNs = Number(view.getBigUint64(40, true));
        return {
            pid,
            port,
            comm,
            acceptCount,
            avgLatencyMs: acceptCount > 0
                ? totalLatency / acceptCount / 1_000_000
                : 0,
            lastSeenNs,
        };
    }

    private readTopologyEdge(buf: Buffer, portNames: Record<number, string>): TopologyEdge {
        const view = new DataView(buf.buffer);
        const source = this.readCString(buf, 0, 16);
        const containerId = this.readCString(buf, 16, 16);
        const displaySource = containerId || source;

        const sourceIp = [buf[32], buf[33], buf[34], buf[35]].join(".");
        const destIp = [buf[36], buf[37], buf[38], buf[39]].join(".");
        const destPort = view.getUint16(40, true);

        const hitCount = Number(view.getBigUint64(48, true));
        const totalLatencyNs = Number(view.getBigUint64(56, true));
        const lastSeenNs = Number(view.getBigUint64(64, true));
        const totalBytes = Number(view.getBigUint64(72, true));
        const errorCount = Number(view.getBigUint64(80, true));
        const retransmitCount = Number(view.getBigUint64(88, true));
        const grpcService = this.readCString(buf, 96, 32);

        const target = portNames[destPort] || `${destIp}:${destPort}`;
        const avgLatencyUs = hitCount > 0 ? totalLatencyNs / hitCount / 1000 : 0;

        return { source: displaySource, target, containerId, sourceIp, destIp, destPort,
            hitCount, avgLatencyUs: Math.round(avgLatencyUs), lastSeenNs, totalBytes,
            errorCount, retransmitCount, grpcService: grpcService || undefined };
    }

    private mergeSubgraphs(edges: TopologyEdge[]): void {
        const ipToSource = new Map<string, string>();
        for (const edge of edges) {
            if (edge.sourceIp !== "0.0.0.0") ipToSource.set(edge.sourceIp, edge.source);
        }
        for (const edge of edges) {
            const resolvedComm = ipToSource.get(edge.destIp);
            if (resolvedComm) edge.target = resolvedComm;
        }
    }

    /** Format binary bytes as hex string. */
    private bytesToHex(bytes: Uint8Array): string {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    /** Format a 64-bit span ID as 16-char hex, nullifying zero. */
    private formatSpanId(val: bigint): string | undefined {
        const hex = val.toString(16).padStart(16, "0");
        return hex === "0000000000000000" ? undefined : hex;
    }

    /** Decode HTTP metadata from trace span bytes field. */
    private decodeHttpMeta(bytes: number): { statusCode?: number; method?: string } {
        const names: Record<number, string> = { 0: "UNKNOWN", 1: "GET", 2: "POST", 3: "PUT", 4: "DELETE", 5: "PATCH", 6: "HEAD" };
        const methodCode = (bytes >> 8) & 0xFF;
        return {
            statusCode: ((bytes >> 16) & 0xFFFF) || undefined,
            method: names[methodCode] || "UNKNOWN",
        };
    }

    /** Read a trace span record from the C trace span buffer. */
    private readTraceSpan(buf: Buffer): IngestEvent | null {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const traceId = this.bytesToHex(new Uint8Array(buf.buffer, buf.byteOffset + 8, 16));
        if (traceId === "00000000000000000000000000000000") return null;

        const timestampNs = Number(view.getBigUint64(0, true));
        const bytes = Number(view.getBigUint64(70, true));
        const httpMeta = this.decodeHttpMeta(bytes);
        const sid = this.formatSpanId(view.getBigUint64(24, true));
        const psid = this.formatSpanId(view.getBigUint64(32, true));
        const comm = this.readCString(buf, 54, 16);

        return {
            traceId,
            spanId: sid || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            parentSpanId: psid,
            service: comm || "unknown",
            durationMs: 0,
            isError: buf[78] !== 0,
            timestamp: timestampNs / 1_000_000,
            ...httpMeta,
        };
    }
}

