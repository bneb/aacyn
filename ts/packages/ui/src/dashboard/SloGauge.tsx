"use client";

import { useState, useEffect, useCallback } from "react";

// Types

interface SloDefinition {
    name: string;
    service: string;
    targetPct: number;
    metric: string;
    threshold: number;
    unit: string;
}

interface SloState {
    definition: SloDefinition;
    totalEvents: number;
    badEvents: number;
    budgetRemaining: number;
    burnRate1h: number;
    burnRate6h: number;
}

interface SloResponse {
    slos: SloState[];
}

// Exported constants

export const SLO_LOADING_MSG = "Loading SLO status...";
export const SLO_EMPTY_MSG = "No SLOs defined. Define SLOs to track error budgets and burn rates.";

// Helpers

function budgetColor(pct: number): string {
    if (pct <= 0) return "#ef4444";
    if (pct < 0.25) return "#f97316";
    if (pct < 0.5) return "#eab308";
    return "#22c55e";
}

function burnRateLabel(rate: number): { text: string; color: string } {
    if (rate > 10) return { text: "CRITICAL", color: "text-red-400" };
    if (rate > 2) return { text: "HIGH", color: "text-orange-400" };
    if (rate > 1) return { text: "ELEVATED", color: "text-yellow-400" };
    return { text: "NORMAL", color: "text-emerald-400" };
}

function LoadingSkeleton() {
    return (
        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                SLO Status
            </h3>
            <div className="space-y-2">
                {[1, 2].map((i) => (
                    <div key={i} className="h-8 bg-slate-800 rounded animate-pulse" />
                ))}
            </div>
        </div>
    );
}

// Sub-components

function BudgetBar({ remaining, targetPct }: { remaining: number; targetPct: number }) {
    const pct = Math.max(0, Math.min(100, remaining * 100));
    return (
        <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                        width: `${pct}%`,
                        backgroundColor: budgetColor(remaining),
                    }}
                />
            </div>
            <span className="font-mono tabular-nums text-xs w-12 text-right shrink-0"
                style={{ color: budgetColor(remaining) }}>
                {pct.toFixed(1)}%
            </span>
        </div>
    );
}

function SloRow({ state }: { state: SloState }) {
    const burn = burnRateLabel(Math.max(state.burnRate1h, state.burnRate6h));
    return (
        <div className="px-2 py-2 rounded border border-slate-800/50 bg-slate-900/30">
            <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-300">
                        {state.definition.name}
                    </span>
                    <span className="text-[10px] text-slate-600">
                        {state.definition.service === "*" ? "all services" : state.definition.service}
                    </span>
                </div>
                <span className={`font-mono text-[10px] uppercase tracking-wider ${burn.color}`}>
                    {burn.text}
                </span>
            </div>
            <BudgetBar remaining={state.budgetRemaining} targetPct={state.definition.targetPct} />
            <div className="flex gap-3 mt-1 text-[10px] text-slate-600 font-mono">
                <span title="1-hour burn rate">1h: {state.burnRate1h.toFixed(1)}x</span>
                <span title="6-hour burn rate">6h: {state.burnRate6h.toFixed(1)}x</span>
                <span title="Target">{state.definition.targetPct}% ({state.definition.unit})</span>
            </div>
        </div>
    );
}

// SloList — extracted for function length limit

function SloList({ slos }: { slos: SloState[] }) {
    return (
        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                SLO Status
            </h3>
            <div className="space-y-1.5">
                {slos.map((slo) => (
                    <SloRow key={`${slo.definition.service}:${slo.definition.name}`} state={slo} />
                ))}
            </div>
        </div>
    );
}

function EmptySloState() {
    return (
        <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                SLO Status
            </h3>
            <p className="text-sm text-slate-600">{SLO_EMPTY_MSG}</p>
        </div>
    );
}

// Main component

interface Props {
    apiUrl?: string;
    pollInterval?: number;
}

export function SloGauge({ apiUrl, pollInterval = 5000 }: Props) {
    const [slos, setSlos] = useState<SloState[] | null>(null);

    const fetchSlos = useCallback(async () => {
        if (!apiUrl) return;
        try {
            const res = await fetch(`${apiUrl}/v1/slo`);
            if (!res.ok) return;
            setSlos(((await res.json()) as SloResponse).slos || []);
        } catch {
            // API not reachable — keep last known state
        }
    }, [apiUrl]);

    useEffect(() => {
        fetchSlos();
        const timer = setInterval(fetchSlos, pollInterval);
        return () => clearInterval(timer);
    }, [fetchSlos, pollInterval]);

    if (!apiUrl) return <EmptySloState />;
    if (slos === null) return <LoadingSkeleton />;
    if (slos.length === 0) return <EmptySloState />;
    return <SloList slos={slos} />;
}
