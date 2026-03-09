/**
 * TraceWaterfall — Span Tree Visualization
 *
 * Renders a list of spans with indentation showing parent/child
 * relationships. Each span is a horizontal bar whose width is
 * proportional to its duration relative to the total trace duration.
 *
 * When no spans are available, shows a helpful empty state.
 */

import React from "react";

// ─── Types ────────────────────────────────────────────────────────────────

export interface SpanNode {
    spanId: string;
    parentSpanId: string | null;
    service: string;
    durationMs: number;
    isError: boolean;
    timestamp: number;
    method?: string;
    statusCode?: string;
    path?: string;
    children: SpanNode[];
}

export interface TraceWaterfallProps {
    traceId: string;
    spans: SpanNode[];
    totalDurationMs: number;
    loading?: boolean;
}

// ─── Empty States ─────────────────────────────────────────────────────────

export const NO_TRACE_FOUND_MSG = "Trace not found. The trace ID may be incorrect or the data has been garbage collected from the ring buffer.";
export const LOADING_TRACE_MSG = "Loading trace data...";

// ─── Flatten Tree to Rows ─────────────────────────────────────────────────

interface FlatRow {
    span: SpanNode;
    depth: number;
}

function flattenTree(nodes: SpanNode[], depth = 0): FlatRow[] {
    const rows: FlatRow[] = [];
    for (const node of nodes) {
        rows.push({ span: node, depth });
        if (node.children.length > 0) {
            rows.push(...flattenTree(node.children, depth + 1));
        }
    }
    return rows;
}

// ─── Color Helpers ────────────────────────────────────────────────────────

const SERVICE_COLORS: Record<string, string> = {
    "auth-service": "#6366f1",
    "payment-gateway": "#f59e0b",
    "api": "#10b981",
    "frontend": "#3b82f6",
    "db": "#ef4444",
};

function getServiceColor(service: string): string {
    const cached = SERVICE_COLORS[service];
    if (cached) return cached;
    let hash = 0;
    for (let i = 0; i < service.length; i++) {
        hash = service.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────

function LoadingSkeleton() {
    return (
        <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-800">
            <div className="animate-pulse space-y-3">
                <div className="h-4 bg-slate-800 rounded w-1/3" />
                <div className="h-8 bg-slate-800 rounded" />
                <div className="h-8 bg-slate-800 rounded w-2/3" />
                <div className="h-8 bg-slate-800 rounded w-1/2" />
            </div>
        </div>
    );
}

// ─── Empty State ──────────────────────────────────────────────────────────

function EmptyState({ traceId }: { traceId: string }) {
    return (
        <div className="rounded-lg bg-slate-900/50 p-6 border border-slate-800 text-center">
            <div className="text-slate-400 text-sm">{NO_TRACE_FOUND_MSG}</div>
            <div className="text-slate-600 text-xs mt-2 font-mono">{traceId}</div>
        </div>
    );
}

// ─── Single Span Row ─────────────────────────────────────────────────────

function SpanRow({ row, minTs, range, depth }: { row: FlatRow; minTs: number; range: number; depth: number }) {
    const span = row.span;
    const startPct = ((span.timestamp - minTs) / range) * 100;
    const widthPct = Math.max((span.durationMs / range) * 100, 0.5);
    const color = getServiceColor(span.service);

    return (
        <div className="flex items-center px-4 py-1.5 hover:bg-slate-800/30 text-[11px]">
            <div className="w-48 shrink-0 truncate flex items-center gap-1" style={{ paddingLeft: `${depth * 16}px` }}>
                {depth > 0 && <span className="text-slate-600 select-none">{'└'}</span>}
                <span className="text-slate-300 truncate">{span.service}</span>
                {span.method && (
                    <span className="text-[10px] px-1 rounded bg-slate-800 text-slate-400 font-mono">{span.method}</span>
                )}
            </div>
            <div className="flex-1 relative h-5 flex items-center">
                <div className="absolute h-3 rounded-full opacity-80" style={{ left: `${startPct}%`, width: `${widthPct}%`, backgroundColor: color }} />
                {span.isError && <div className="absolute w-2 h-2 rounded-full bg-red-400" style={{ left: `${Math.min(startPct + widthPct, 99)}%` }} />}
            </div>
            <div className="w-20 text-right shrink-0 text-slate-400 font-mono tabular-nums">{span.durationMs.toFixed(1)}ms</div>
        </div>
    );
}

// ─── Timeline Header ─────────────────────────────────────────────────────

function TimelineHeader() {
    return (
        <div className="px-4 py-1.5 border-b border-slate-800/50 flex text-[10px] text-slate-500 font-mono">
            <div className="w-48 shrink-0" />
            <div className="flex-1 relative h-4">
                {[0, 25, 50, 75, 100].map(pct => (
                    <div key={pct} className="absolute top-0 -translate-x-1/2" style={{ left: `${pct}%` }}>{pct}%</div>
                ))}
            </div>
            <div className="w-20 text-right shrink-0">Duration</div>
        </div>
    );
}

// ─── Main Component ─────────────────────────────────────────────────────

export function TraceWaterfall({ traceId, spans, totalDurationMs, loading = false }: TraceWaterfallProps) {
    if (loading) return <LoadingSkeleton />;
    if (spans.length === 0) return <EmptyState traceId={traceId} />;

    const rows = flattenTree(spans);
    const minTs = Math.min(...rows.map(r => r.span.timestamp));
    const maxEnd = Math.max(...rows.map(r => r.span.timestamp + r.span.durationMs));
    const range = Math.max(maxEnd - minTs, 1);

    return (
        <div className="rounded-lg bg-slate-900/50 border border-slate-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Trace Waterfall</h3>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{rows.length} spans</span>
                </div>
                <div className="text-[10px] font-mono text-slate-500">{totalDurationMs.toFixed(2)}ms total</div>
            </div>
            <TimelineHeader />
            <div className="divide-y divide-slate-800/30 max-h-96 overflow-y-auto">
                {rows.map((row, i) => <SpanRow key={row.span.spanId || String(i)} row={row} minTs={minTs} range={range} depth={row.depth} />)}
            </div>
        </div>
    );
}