import type { IStore, TopologyEdge, DiscoveredService } from "@aacyn/sdk";

// ── Native engine unavailable warning ────────────────────────────────────

const _methodsWarned = new Set<string>();

function warnNativeUnavailable(method: string): void {
    if (_methodsWarned.has(method)) return;
    _methodsWarned.add(method);
    console.warn(
        `[store] Native engine not available — "${method}" requires the native C engine. ` +
        `Build it with "cd native && make" or set LIBAACYN_PATH. ` +
        `All native-dependent methods return empty/zero results gracefully.`
    );
}

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

/**
 * EventStore uses a Map (hash table) for O(1) trace ID lookups.
 * At 10K events with UUID keys, lookup is effectively constant time.
 */
class EventStore implements IStore {
    /**
     * Trace span index: maps traceId → array of spans.
     * Supports multiple spans per trace for span tree building.
     */
    private readonly index = new Map<string, IngestEvent[]>();
    private _count = 0;

    ingestBatch(events: IngestEvent[]): number {
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            const indexed = { ...event };
            if (!indexed.spanId) {
                indexed.spanId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
            }
            const spans = this.index.get(indexed.traceId) || [];
            spans.push(indexed);
            this.index.set(indexed.traceId, spans);
        }
        this._count += events.length;
        return events.length;
    }

    ingestBinary(_buffer: ArrayBuffer): number {
        warnNativeUnavailable("ingestBinary");
        return 0;
    }

    getByTraceId(traceId: string): IngestEvent | undefined {
        const spans = this.index.get(traceId);
        return spans ? spans[0] : undefined;
    }

    getTraceSpans(traceId: string): IngestEvent[] | undefined {
        return this.index.get(traceId);
    }

    drainTraceSpans(): number {
        return 0; // No-op for V8 fallback
    }

    query(opts: { startNs?: number; endNs?: number; errorOnly?: boolean; limit?: number }): { timestamp: number; duration: number; isError: boolean }[] {
        const results: { timestamp: number; duration: number; isError: boolean }[] = [];
        const max = opts.limit ?? Infinity;
        for (const spans of this.index.values()) {
            if (results.length >= max) break;
            for (const event of spans) {
                if (results.length >= max) break;
                if (opts.startNs && event.timestamp < opts.startNs) continue;
                if (opts.endNs && event.timestamp > opts.endNs) continue;
                if (opts.errorOnly && !event.isError) continue;
                results.push({ timestamp: event.timestamp, duration: event.durationMs, isError: event.isError });
            }
        }
        return results;
    }

    get count(): number {
        return this._count;
    }

    get size(): number {
        return this.index.size;
    }

    clear(): void {
        this.index.clear();
        this._count = 0;
    }

    scanDurationMax(): number {
        warnNativeUnavailable("scanDurationMax");
        return 0;
    }

    scanErrorCount(): number {
        warnNativeUnavailable("scanErrorCount");
        return 0;
    }

    setRules(_ruleBuffer: Uint8Array, _count: number): void {
        warnNativeUnavailable("setRules");
    }

    eventsDropped(): number {
        warnNativeUnavailable("eventsDropped");
        return 0;
    }

    byteSize(): number {
        // Rough estimate
        return this.index.size * 256;
    }

    nativeLen(): number {
        return this.index.size;
    }

    head(): number {
        return this.index.size;
    }

    extractRaw(_fromHead: number, _count: number): { buffer: Buffer; extracted: number } {
        warnNativeUnavailable("extractRaw");
        return { buffer: Buffer.alloc(0), extracted: 0 };
    }

    ebpfAttach(_bpfObjPath: string): number {
        warnNativeUnavailable("ebpfAttach");
        return 0;
    }

    ebpfPoll(_timeoutMs?: number): number {
        warnNativeUnavailable("ebpfPoll");
        return 0;
    }

    ebpfDetach(): void {
        warnNativeUnavailable("ebpfDetach");
    }

    ebpfDrainCount(): number {
        return 0; // Not strictly an error to ask, just returns 0 since we're a V8 fallback
    }

    dropCounts(): { standard: number; critical: number } {
        return { standard: 0, critical: 0 };
    }

    discoveredServices(): DiscoveredService[] {
        return []; // V8 fallback has no discovered services
    }

    topologyEdges(): TopologyEdge[] {
        return []; // V8 fallback has no topology
    }

    sync(): void {
        // No-op for memory store
    }

    destroy(): void {
        this.clear();
    }
}

export const store = new EventStore();
