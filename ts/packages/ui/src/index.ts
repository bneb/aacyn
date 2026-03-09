/**
 * @aacyn/ui — Shared Component Library
 *
 * React components for the aacyn dashboard and marketing site.
 * Framework-agnostic type definitions are in @aacyn/sdk.
 */

// Re-export SDK types for convenience
export type { TelemetryEvent, RedMetric, QueryResponse } from "@aacyn/sdk";

// ─── Dashboard Components (Sprint 3: extracted from routes/dashboard.ts) ───
export { TopologyGraph, GoldenSignals, EvidenceFeed, TraceWaterfall } from "./dashboard";
export type { TopologyEdge, GoldenSignal, GoldenSignalData, SpanNode, TraceWaterfallProps } from "./dashboard";

// ─── Component Props (design system types) ──────────────────────────────

export interface MetricCardProps {
    title: string;
    value: number;
    unit: string;
    change?: number;
    status: "normal" | "warning" | "critical";
    sparkline?: number[];
}

export interface LogStreamProps {
    logs: LogEntry[];
    onFilter?: (query: string) => void;
}

export interface LogEntry {
    timestamp: number;
    level: "debug" | "info" | "warn" | "error" | "fatal";
    service: string;
    message: string;
    attributes: Record<string, unknown>;
}

export interface CommandPaletteProps {
    isOpen: boolean;
    onClose: () => void;
    onCommand: (command: string) => void;
    suggestions: CommandSuggestion[];
}

export interface CommandSuggestion {
    id: string;
    label: string;
    description: string;
    shortcut?: string;
    icon?: string;
}
