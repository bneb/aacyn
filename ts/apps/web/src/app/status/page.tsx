"use client";

import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type { TopologyEdge, GoldenSignal } from "@aacyn/ui/dashboard";

/** Subset of the full dashboard API response — mirrors app/dashboard/page.tsx. */
interface DashboardPayload {
    edges: TopologyEdge[];
    total_ebpf_events: number;
    drops: { standard: number; critical: number };
    golden_signals: GoldenSignal[];
    uptime_seconds: number;
    source: string;
    performance?: {
        events_per_sec: number;
        scan_latency_us: number;
        simd: string;
    };
}

const DATA_URL = process.env.NEXT_PUBLIC_AACYN_API_URL
    ? `${process.env.NEXT_PUBLIC_AACYN_API_URL}/v1/dashboard/data`
    : "http://localhost:3001/v1/dashboard/data";

function formatTimestamp(date: Date): string {
    return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
}

function statusColor(value: number, warn: number, crit: number): string {
    if (value >= crit) return "text-red-400";
    if (value >= warn) return "text-yellow-400";
    return "text-emerald-400";
}

function formatLatency(ms: number): string {
    if (ms < 1) return `${(ms * 1000).toFixed(0)} μs`;
    if (ms < 1000) return `${ms.toFixed(1)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

function StatusContent() {
    const [data, setData] = useState<DashboardPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastFetch, setLastFetch] = useState<Date | null>(null);
    const searchParams = useSearchParams();
    const router = useRouter();
    const serviceFilter = searchParams.get("service");

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(DATA_URL);
            if (res.ok) {
                const payload: DashboardPayload = await res.json();
                setData(payload);
                setError(null);
                setLastFetch(new Date());
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch {
            setError("Status data temporarily unavailable — our monitoring API may be restarting.");
            setLastFetch(new Date());
        }
    }, []);

    useEffect(() => {
        fetchData();
        const timer = setInterval(fetchData, 5000);
        return () => clearInterval(timer);
    }, [fetchData]);

    const totalDrops = data
        ? (data.drops.standard || 0) + (data.drops.critical || 0)
        : 0;

    const dropColor =
        data && data.drops.critical > 0
            ? "text-red-400"
            : data && data.drops.standard > 0
                ? "text-yellow-400"
                : "text-emerald-400";

    // Filter data when a service is selected (click-through from golden signals)
    const filteredEdges = useMemo(() => {
        if (!data || !serviceFilter) return data?.edges ?? [];
        const svc = serviceFilter.toLowerCase();
        return data.edges.filter(
            e => e.source.toLowerCase() === svc || e.target.toLowerCase() === svc,
        );
    }, [data, serviceFilter]);

    const filteredSignals = useMemo(() => {
        if (!data || !serviceFilter) return data?.golden_signals ?? [];
        const svc = serviceFilter.toLowerCase();
        return data.golden_signals.filter(s => s.service.toLowerCase() === svc);
    }, [data, serviceFilter]);

    return (
        <div className="min-h-screen bg-[#0a0a0f] text-slate-200">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-4 border-b border-indigo-500/10 bg-slate-900/60 backdrop-blur-xl">
                <div>
                    <h1 className="text-lg font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                        aacyn monitors aacyn
                    </h1>
                    <p className="text-xs text-slate-500 mt-0.5">
                        Live Infrastructure Status
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <span
                        className={`inline-block w-2 h-2 rounded-full ${
                            error
                                ? "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]"
                                : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                        }`}
                    />
                    <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                        {error ? "Degraded" : "Live"}
                    </span>
                </div>
            </header>

            {/* Subtitle / filter banner */}
            <div className="px-6 py-3 border-b border-slate-800/50">
                {serviceFilter ? (
                    <div className="flex items-center justify-between">
                        <p className="text-sm text-slate-300">
                            <span className="text-indigo-400 font-mono font-semibold">{serviceFilter}</span>
                            <span className="text-slate-500"> — filtered view showing only this service&apos;s edges and signals.</span>
                        </p>
                        <button
                            type="button"
                            onClick={() => router.push("/status")}
                            className="text-xs font-mono text-slate-500 hover:text-slate-300 px-2 py-1 rounded hover:bg-slate-800/50 transition-colors"
                        >
                            Clear filter
                        </button>
                    </div>
                ) : (
                    <p className="text-sm text-slate-500 max-w-2xl leading-relaxed">
                        This page shows aacyn&apos;s own infrastructure topology, captured entirely via eBPF kernel
                        probes with zero application instrumentation.
                    </p>
                )}
            </div>

            <main className="p-6 max-w-5xl mx-auto space-y-6">
                {/* Error Banner */}
                {error && (
                    <div className="p-4 bg-red-900/20 border border-red-800/30 rounded-lg">
                        <p className="text-sm text-red-300">
                            {error}
                        </p>
                        {lastFetch && !data && (
                            <p className="text-xs text-red-400/60 mt-1 font-mono">
                                Last successful fetch: {formatTimestamp(lastFetch)}
                            </p>
                        )}
                    </div>
                )}

                {/* Topology Summary Cards */}
                <section>
                    <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                        Topology Summary
                    </h2>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {/* Edges */}
                        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
                            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                                Total Edges
                            </div>
                            <div className="text-2xl font-bold font-mono tabular-nums text-indigo-400">
                                {data ? data.edges.length.toLocaleString() : "—"}
                            </div>
                        </div>

                        {/* Services */}
                        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
                            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                                Total Services
                            </div>
                            <div className="text-2xl font-bold font-mono tabular-nums text-indigo-400">
                                {data ? data.golden_signals.length.toLocaleString() : "—"}
                            </div>
                        </div>

                        {/* eBPF Events */}
                        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
                            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                                eBPF Events
                            </div>
                            <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
                                {data ? data.total_ebpf_events.toLocaleString() : "—"}
                            </div>
                        </div>

                        {/* Ring Buffer Drops */}
                        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
                            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                                Ring Buffer Drops
                            </div>
                            <div className={`text-2xl font-bold font-mono tabular-nums ${data ? dropColor : "text-slate-600"}`}>
                                {data ? totalDrops.toLocaleString() : "—"}
                            </div>
                            {data && (
                                <div className="text-[10px] text-slate-600 font-mono mt-1">
                                    {data.drops.standard} std / {data.drops.critical} crit
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* Golden Signals Table */}
                <section>
                    <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                        Golden Signals
                    </h2>
                    <div className="bg-slate-900/50 rounded-lg border border-slate-800 overflow-hidden">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-800">
                                    <th className="text-left px-4 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                        Service
                                    </th>
                                    <th className="text-right px-4 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                        Error Rate
                                    </th>
                                    <th className="text-right px-4 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                        Latency
                                    </th>
                                    <th className="text-right px-4 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                        Throughput
                                    </th>
                                    <th className="text-right px-4 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                        Rate
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {data && filteredSignals.length > 0 ? (
                                    filteredSignals.slice(0, 20).map((sig) => (
                                        <tr
                                            key={sig.service}
                                            className="border-b border-slate-800/50 last:border-b-0 hover:bg-slate-800/30"
                                        >
                                            <td className="px-4 py-2.5 font-mono text-slate-300">
                                                {sig.service}
                                            </td>
                                            <td className={`px-4 py-2.5 font-mono tabular-nums text-right ${statusColor(sig.error_pct, 1, 5)}`}>
                                                {sig.error_pct.toFixed(2)}%
                                            </td>
                                            <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-400">
                                                {formatLatency(sig.avg_latency_ms)}
                                            </td>
                                            <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-400">
                                                {sig.throughput_kbps.toFixed(1)} KB/s
                                            </td>
                                            <td className="px-4 py-2.5 font-mono tabular-nums text-right text-slate-500">
                                                {sig.rate_rps.toFixed(2)} req/s
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="px-4 py-8 text-center text-sm text-slate-600"
                                        >
                                            {data
                                                ? "No services discovered yet. Deploy eBPF probes to see signals."
                                                : "Waiting for data..."}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* eBPF Evidence Feed */}
                <section>
                    <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                        eBPF Evidence Feed{" "}
                        {data && (
                            <span className="text-slate-600 font-normal">
                                (last {Math.min(filteredEdges.length, 20)} of {filteredEdges.length} edges)
                            </span>
                        )}
                    </h2>
                    <div className="bg-slate-900/50 rounded-lg border border-slate-800 overflow-hidden">
                        {data && filteredEdges.length > 0 ? (
                            <div className="divide-y divide-slate-800/50 max-h-80 overflow-y-auto">
                                {filteredEdges
                                    .slice(-20)
                                    .reverse()
                                    .map((edge, i) => (
                                        <div
                                            key={i}
                                            className="px-4 py-2 flex items-center gap-3 text-xs font-mono hover:bg-slate-800/20"
                                        >
                                            <span className="flex-shrink-0 text-[10px]">
                                                {edge.error_count > 0
                                                    ? "🔴"
                                                    : edge.latency_us > 2000
                                                        ? "🟡"
                                                        : "🟢"}
                                            </span>
                                            <span className="text-indigo-400 font-medium">
                                                {edge.source}
                                            </span>
                                            <span className="text-slate-600">→</span>
                                            <span className="text-slate-300 font-medium">
                                                {edge.target}
                                            </span>
                                            <span className="text-slate-500 ml-auto tabular-nums">
                                                {edge.latency_us.toLocaleString()} μs
                                            </span>
                                            {edge.hit_count > 0 && (
                                                <span className="text-slate-600 tabular-nums">
                                                    ×{edge.hit_count}
                                                </span>
                                            )}
                                            {edge.error_count > 0 && (
                                                <span className="text-red-400 tabular-nums">
                                                    err:{edge.error_count}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                            </div>
                        ) : (
                            <div className="px-4 py-8 text-center text-sm text-slate-600">
                                {data
                                    ? "Waiting for kernel events..."
                                    : "Waiting for data..."}
                            </div>
                        )}
                    </div>
                </section>

                {/* Last fetch timestamp */}
                <div className="text-center text-[10px] text-slate-700 font-mono">
                    {lastFetch
                        ? `Last updated: ${formatTimestamp(lastFetch)}`
                        : "Fetching..."}
                </div>
            </main>
        </div>
    );
}

export default function StatusPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
                <div className="animate-pulse text-slate-600 font-mono text-sm">Loading...</div>
            </div>
        }>
            <StatusContent />
        </Suspense>
    );
}
