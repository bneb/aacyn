"use client";

import { useState, useEffect, useCallback } from "react";

const DATA_URL = process.env.NEXT_PUBLIC_AACYN_API_URL
    ? `${process.env.NEXT_PUBLIC_AACYN_API_URL}/v1/dashboard/data`
    : "http://localhost:3001/v1/dashboard/data";

function formatNum(n: number): string {
    return n.toLocaleString();
}

export function LiveStatusCard() {
    const [counts, setCounts] = useState<{
        edges: number;
        services: number;
        events: number;
    } | null>(null);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(DATA_URL, { cache: "no-store" });
            if (res.ok) {
                const data = await res.json();
                if (data && data.edges && Array.isArray(data.edges)) {
                    setCounts({
                        edges: data.edges.length,
                        services: data.golden_signals?.length ?? 0,
                        events: data.total_ebpf_events ?? 0,
                    });
                }
            }
        } catch (err) {
            // API unreachable — keep existing state; first load shows deployment prompt
        }
    }, []);

    useEffect(() => {
        fetchData();
        const timer = setInterval(fetchData, 10000);
        return () => clearInterval(timer);
    }, [fetchData]);

    if (!counts) {
        return (
            <div className="inline-flex items-center px-6 py-4 bg-slate-900/80 border border-slate-800 rounded-lg backdrop-blur-sm">
                <p className="text-sm text-slate-500 font-mono">
                    Deploy aacyn and set <code className="text-slate-400">NEXT_PUBLIC_AACYN_API_URL</code> to see live cluster topology here.
                </p>
            </div>
        );
    }

    return (
        <div className="inline-flex items-center gap-8 px-6 py-4 bg-slate-900/80 border border-slate-800 rounded-lg backdrop-blur-sm">
            <div className="flex flex-col items-center">
                <span className="text-2xl font-bold font-mono tabular-nums text-indigo-400">
                    {formatNum(counts.edges)}
                </span>
                <span className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
                    Edges
                </span>
            </div>
            <div className="flex flex-col items-center">
                <span className="text-2xl font-bold font-mono tabular-nums text-indigo-400">
                    {formatNum(counts.services)}
                </span>
                <span className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
                    Services
                </span>
            </div>
            <div className="flex flex-col items-center">
                <span className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
                    {formatNum(counts.events)}
                </span>
                <span className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
                    eBPF Events
                </span>
            </div>
        </div>
    );
}
