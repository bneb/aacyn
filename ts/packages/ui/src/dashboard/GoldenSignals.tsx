"use client";

import { useState, useMemo } from "react";

// ── Types ──────────────────────────────────────────────────────────

export interface GoldenSignalData {
    service: string;
    rate_rps: number;
    error_pct: number;
    avg_latency_ms: number;
    p50_ms?: number;
    p95_ms?: number;
    p99_ms?: number;
    throughput_kbps: number;
    http_rate_rps?: number;
    http_error_pct?: number;
    http_2xx?: number;
    http_3xx?: number;
    http_4xx?: number;
    http_5xx?: number;
    sparkline?: number[];
}

interface Props {
    services: GoldenSignalData[];
    loading?: boolean;
}

// ── Exported constants (tested by empty-states.test.tsx) ────────────

export const COLLECTING_DATA_MSG =
    "Collecting data — golden signals (rate, errors, latency) appear after 30 seconds of eBPF observation. The engine needs enough TCP events to compute statistically meaningful aggregates.";

export const NO_SERVICES_YET_MSG =
    "No services discovered yet. Deploy eBPF probes to see signals.";

// ── Sort configuration ────────────────────────────────────────────

type SortKey = "error_pct" | "p99_ms" | "rate_rps" | "name";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "error_pct", label: "Error Rate" },
    { key: "p99_ms", label: "P99 Latency" },
    { key: "rate_rps", label: "Request Rate" },
    { key: "name", label: "Name" },
];

const WARN_THRESHOLD = 1;
const CRIT_THRESHOLD = 5;

// ── Helpers ────────────────────────────────────────────────────────

function errorColorClass(pct: number): string {
    if (pct >= CRIT_THRESHOLD) return "text-red-400";
    if (pct >= WARN_THRESHOLD) return "text-yellow-400";
    return "text-emerald-400";
}

function errorBorderClass(pct: number): string {
    if (pct >= CRIT_THRESHOLD) return "border-red-800/60";
    if (pct >= WARN_THRESHOLD) return "border-yellow-800/50";
    return "border-transparent";
}

function parseSortKey(v: string): SortKey {
    if (v === "error_pct" || v === "p99_ms" || v === "rate_rps" || v === "name") return v;
    return "error_pct";
}

function formatLatency(sig: GoldenSignalData): string {
    if (sig.p50_ms !== undefined) {
        return `${sig.p50_ms.toFixed(0)}/${(sig.p95_ms ?? 0).toFixed(0)}/${(sig.p99_ms ?? 0).toFixed(0)}ms`;
    }
    return `${sig.avg_latency_ms.toFixed(1)}ms`;
}

function latencyTitle(sig: GoldenSignalData): string {
    if (sig.p50_ms !== undefined) {
        return `p50: ${sig.p50_ms.toFixed(1)}ms | p95: ${(sig.p95_ms ?? 0).toFixed(1)}ms | p99: ${(sig.p99_ms ?? 0).toFixed(1)}ms`;
    }
    return `avg: ${sig.avg_latency_ms.toFixed(1)}ms`;
}

function getComparator(sortBy: SortKey): (a: GoldenSignalData, b: GoldenSignalData) => number {
    switch (sortBy) {
        case "error_pct":
            return (a, b) => b.error_pct - a.error_pct;
        case "p99_ms":
            return (a, b) => (b.p99_ms ?? b.avg_latency_ms) - (a.p99_ms ?? a.avg_latency_ms);
        case "rate_rps":
            return (a, b) => b.rate_rps - a.rate_rps;
        case "name":
            return (a, b) => a.service.localeCompare(b.service);
    }
}

// ── Sparkline (SVG polyline mini-chart) ───────────────────────────

function Sparkline({ data, className = "" }: { data: number[]; className?: string }) {
    if (data.length < 2) return null;
    const w = 100, h = 24, pad = 1;
    const max = Math.max(...data), min = Math.min(...data);
    const range = max - min || 1;
    const points = data
        .map((v, i) => {
            const x = (i / (data.length - 1)) * (w - 2 * pad) + pad;
            const y = h - ((v - min) / range) * (h - 2 * pad) - pad;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    return (
        <svg viewBox={`0 0 ${w} ${h}`} className={`inline-block align-middle shrink-0 ${className}`}
            width={w} height={h} aria-label="Request rate sparkline">
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
}

// ── HTTP Status Breakdown (stacked bar) ──────────────────────────

function HttpBreakdownBar({ http2xx, http3xx, http4xx, http5xx }: {
    http2xx: number; http3xx: number; http4xx: number; http5xx: number;
}) {
    const total = http2xx + http3xx + http4xx + http5xx;
    if (total === 0) return <span className="text-slate-600 text-xs">&mdash;</span>;
    return (
        <div className="flex items-center gap-1.5"
            title={`2xx:${http2xx} 3xx:${http3xx} 4xx:${http4xx} 5xx:${http5xx}`}>
            <div className="flex h-2 w-full max-w-24 rounded-full overflow-hidden bg-slate-800">
                {http2xx > 0 && <div className="bg-emerald-500" style={{ width: `${(http2xx / total) * 100}%` }} />}
                {http3xx > 0 && <div className="bg-blue-500" style={{ width: `${(http3xx / total) * 100}%` }} />}
                {http4xx > 0 && <div className="bg-yellow-500" style={{ width: `${(http4xx / total) * 100}%` }} />}
                {http5xx > 0 && <div className="bg-red-500" style={{ width: `${(http5xx / total) * 100}%` }} />}
            </div>
            <span className="text-slate-500 text-xs tabular-nums">{total}</span>
        </div>
    );
}

// ── Search + Sort Filter Bar ─────────────────────────────────────

function FilterBar({ search, onSearchChange, sortBy, onSortChange }: {
    search: string; onSearchChange: (v: string) => void;
    sortBy: SortKey; onSortChange: (k: SortKey) => void;
}) {
    return (
        <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <input type="text" value={search}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Filter services..."
                className="flex-1 px-2.5 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded text-slate-300 placeholder-slate-500 focus:outline-none focus:border-indigo-500/50" />
            <select value={sortBy}
                onChange={e => onSortChange(parseSortKey(e.target.value))}
                className="px-2.5 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded text-slate-300 focus:outline-none focus:border-indigo-500/50">
                {SORT_OPTIONS.map(opt => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
            </select>
        </div>
    );
}

// ── Loading skeleton ─────────────────────────────────────────────

function LoadingSkeleton() {
    return (
        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <div className="h-3 w-36 bg-slate-800 rounded animate-pulse mb-4" />
            <div className="space-y-3">
                {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center gap-4">
                        <div className="h-4 w-24 bg-slate-800 rounded animate-pulse" />
                        <div className="h-4 w-16 bg-slate-800 rounded animate-pulse" />
                        <div className="h-4 w-20 bg-slate-800 rounded animate-pulse" />
                        <div className="h-4 w-16 bg-slate-800 rounded animate-pulse" />
                        <div className="h-4 w-24 bg-slate-800 rounded animate-pulse" />
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Empty state ──────────────────────────────────────────────────

function EmptyState() {
    return (
        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Golden Signals (RED: Rate · Errors · Duration)
            </h3>
            <p className="text-sm text-slate-600">{NO_SERVICES_YET_MSG}</p>
        </div>
    );
}

// ── Signal Row ───────────────────────────────────────────────────

function LatencyCell({ sig }: { sig: GoldenSignalData }) {
    return (
        <span className="font-mono tabular-nums text-xs text-slate-400 shrink-0 whitespace-nowrap"
            title={latencyTitle(sig)}>
            {formatLatency(sig)}
        </span>
    );
}

function SignalRow({ sig }: { sig: GoldenSignalData }) {
    const ec = errorBorderClass(sig.error_pct);
    const sc = errorColorClass(sig.error_pct);
    const hasSparkline = sig.sparkline !== undefined && sig.sparkline.length >= 2;
    const hasHttp = sig.http_2xx !== undefined;
    return (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 rounded border ${ec}`}>
            <span className="font-mono text-slate-300 text-sm w-28 truncate shrink-0" title={sig.service}>
                {sig.service}
            </span>
            {hasSparkline && <span className="hidden sm:inline-block">
                <Sparkline data={sig.sparkline} className="text-indigo-400" />
            </span>}
            <span className={`font-mono tabular-nums text-xs w-14 text-right shrink-0 ${sc}`}>
                {sig.error_pct.toFixed(1)}%
            </span>
            <LatencyCell sig={sig} />
            <span className="font-mono tabular-nums text-xs text-slate-500 w-16 text-right shrink-0">
                {sig.rate_rps.toFixed(1)}/s
            </span>
            {hasHttp && <span className="hidden sm:inline-block shrink-0 min-w-0">
                <HttpBreakdownBar http2xx={sig.http_2xx} http3xx={sig.http_3xx ?? 0}
                    http4xx={sig.http_4xx ?? 0} http5xx={sig.http_5xx ?? 0} />
            </span>}
        </div>
    );
}

// ── Main Component ───────────────────────────────────────────────

export function GoldenSignals({ services, loading }: Props) {
    const [sortBy, setSortBy] = useState<SortKey>("error_pct");
    const [search, setSearch] = useState("");
    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        let result = q ? services.filter(s => s.service.toLowerCase().includes(q)) : [...services];
        result.sort(getComparator(sortBy));
        return result;
    }, [services, sortBy, search]);
    if (loading && services.length === 0) return <LoadingSkeleton />;
    if (!loading && services.length === 0) return <EmptyState />;
    return (
        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                Golden Signals (RED: Rate · Errors · Duration)
            </h3>
            <FilterBar search={search} onSearchChange={setSearch} sortBy={sortBy} onSortChange={setSortBy} />
            {filtered.length === 0 ? (
                <p className="text-sm text-slate-600">No services match &quot;{search}&quot;</p>
            ) : (
                <div className="space-y-0.5">
                    {filtered.map(sig => <SignalRow key={sig.service} sig={sig} />)}
                </div>
            )}
        </div>
    );
}
