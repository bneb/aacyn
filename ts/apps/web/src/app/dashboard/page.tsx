"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TopologyGraph, GoldenSignals, EvidenceFeed, SloGauge } from "@aacyn/ui/dashboard";
import type { GoldenSignal, TopologyEdge } from "@aacyn/ui/dashboard";

const DEMO_BANNER_DISMISSED_KEY = "aacyn-demo-banner-dismissed";

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

function DemoBanner({ onDismiss }: { onDismiss: () => void }) {
    return (
        <div className="flex items-center justify-between px-4 py-2 bg-amber-950/30 border-b border-amber-800/40 text-amber-300 text-sm">
            <p className="flex items-center gap-2">
                <span className="text-amber-400 font-semibold">Demo data</span>
                <span className="text-amber-300/70">
                    — This is synthetic sample data. Deploy aacyn to your cluster for live eBPF telemetry.
                </span>
                <Link href="/docs" className="text-amber-400 underline hover:text-amber-300 font-medium ml-1">
                    Quickstart &rarr;
                </Link>
            </p>
            <button
                type="button"
                onClick={onDismiss}
                className="text-amber-500 hover:text-amber-300 text-xs font-mono px-2 py-0.5 rounded hover:bg-amber-950/50 transition-colors"
            >
                Dismiss
            </button>
        </div>
    );
}

export default function DashboardPage() {
    const [data, setData] = useState<DashboardPayload | null>(null);
    const [demoDismissed, setDemoDismissed] = useState(() => {
        if (typeof window !== "undefined") {
            return sessionStorage.getItem(DEMO_BANNER_DISMISSED_KEY) === "1";
        }
        return false;
    });
    const router = useRouter();

    const isDemo = data?.source === "demo";

    const dismissDemoBanner = useCallback(() => {
        setDemoDismissed(true);
        sessionStorage.setItem(DEMO_BANNER_DISMISSED_KEY, "1");
    }, []);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(DATA_URL);
            if (res.ok) {
                setData(await res.json());
            }
        } catch {
            // API not reachable — show empty state
        }
    }, []);

    useEffect(() => {
        fetchData();
        const timer = setInterval(fetchData, 2000);
        return () => clearInterval(timer);
    }, [fetchData]);

    const handleServiceClick = useCallback((service: string) => {
        router.push(`/status?service=${encodeURIComponent(service)}`);
    }, [router]);

    return (
        <div className="min-h-screen bg-[#050510] text-slate-200">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-3 bg-slate-900/80 border-b border-indigo-500/10 backdrop-blur-xl">
                <div className="flex items-center gap-3">
                    <h1 className="text-lg font-bold">
                        <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                            aacyn
                        </span>
                    </h1>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded uppercase tracking-wider ${
                        isDemo
                            ? "bg-amber-500/10 text-amber-400"
                            : "bg-indigo-500/10 text-indigo-400"
                    }`}>
                        {isDemo ? "Demo" : "Live"}
                    </span>
                </div>
                <div className="flex items-center gap-4 font-mono text-xs">
                    {data && (
                        <>
                            {data.performance && (
                                <>
                                    <div className="text-right">
                                        <div className="text-slate-500 text-[9px] uppercase">Events/s</div>
                                        <div className="text-cyan-400 tabular-nums">
                                            {data.performance.events_per_sec.toLocaleString()}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-slate-500 text-[9px] uppercase">Scan</div>
                                        <div className="text-blue-400 tabular-nums">
                                            {data.performance.scan_latency_us}μs
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-slate-500 text-[9px] uppercase">SIMD</div>
                                        <div className="text-purple-400 tabular-nums">
                                            {data.performance.simd}
                                        </div>
                                    </div>
                                </>
                            )}
                            <div className="text-right">
                                <div className="text-slate-500 text-[9px] uppercase">Events</div>
                                <div className="text-emerald-400 tabular-nums">
                                    {data.total_ebpf_events.toLocaleString()}
                                </div>
                            </div>
                            <div className="text-right">
                                <div className="text-slate-500 text-[9px] uppercase">Services</div>
                                <div className="text-indigo-400 tabular-nums">
                                    {data.golden_signals.length}
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </header>

            {/* Demo data banner — shown when the store has no real eBPF data */}
            {isDemo && !demoDismissed && <DemoBanner onDismiss={dismissDemoBanner} />}

            {/* Main content */}
            <main className="p-4 space-y-4 max-w-[1600px] mx-auto">
                {/* Topology graph */}
                <TopologyGraph pollInterval={2000} />

                {/* Bottom panels */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2">
                        <GoldenSignals
                            services={data?.golden_signals ?? []}
                            loading={!data}
                            onServiceClick={handleServiceClick}
                        />
                    </div>
                    <div className="space-y-4">
                        <SloGauge
                            apiUrl={process.env.NEXT_PUBLIC_AACYN_API_URL}
                            pollInterval={5000}
                        />
                        {data && <EvidenceFeed edges={data.edges} />}
                    </div>
                </div>
            </main>
        </div>
    );
}
