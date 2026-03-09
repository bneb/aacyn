"use client";

import { useState, useEffect, useCallback } from "react";
import { TopologyGraph, GoldenSignals, EvidenceFeed } from "@aacyn/ui/dashboard";
import type { GoldenSignal, TopologyEdge } from "@aacyn/ui/dashboard";

interface DashboardPayload {
    edges: TopologyEdge[];
    total_ebpf_events: number;
    drops: { standard: number; critical: number };
    golden_signals: GoldenSignal[];
    uptime_seconds: number;
    source: string;
}

const DATA_URL = process.env.NEXT_PUBLIC_AACYN_API_URL
    ? `${process.env.NEXT_PUBLIC_AACYN_API_URL}/v1/dashboard/data`
    : "http://localhost:3001/v1/dashboard/data";

export default function DashboardPage() {
    const [data, setData] = useState<DashboardPayload | null>(null);

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
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 uppercase tracking-wider">
                        Live
                    </span>
                </div>
                <div className="flex items-center gap-4 font-mono text-xs">
                    {data && (
                        <>
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

            {/* Main content */}
            <main className="p-4 space-y-4 max-w-[1600px] mx-auto">
                {/* Topology graph */}
                <TopologyGraph pollInterval={2000} />

                {/* Bottom panels */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <GoldenSignals
                        services={data?.golden_signals ?? []}
                        loading={!data}
                    />
                    {data && <EvidenceFeed edges={data.edges} />}
                </div>
            </main>
        </div>
    );
}
