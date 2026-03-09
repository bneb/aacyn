"use client";

import { useEffect, useRef, useCallback, useState, type MutableRefObject, type RefObject } from "react";
import { createTopologyRenderer, type TopologyRenderer, type RenderEdge } from "./topology-renderer";

// ── Exported empty-state messages (testable constants) ──────────────

export const EBPF_UNAVAILABLE_MSG =
    "eBPF not available — aacyn requires a Linux kernel ≥ 5.15 with BPF filesystem mounted. Running on macOS? Deploy via Docker or Helm to see live topology.";

export const NO_SERVICES_DISCOVERED_MSG =
    "No services discovered — eBPF probes haven't captured any TCP connections yet. Check: (1) Running on Linux kernel ≥ 5.15? (2) Container has CAP_BPF? (3) Is there network traffic to observe?";

export const NO_EDGES_OBSERVED_MSG =
    "No edges observed — waiting for TCP connections. Deploy some services or generate traffic to see topology edges appear.";

// ── Types ────────────────────────────────────────────────────────────

export interface TopologyEdge {
    source: string;
    target: string;
    latency_us: number;
    protocol: string;
    hit_count: number;
    bytes_transferred: number;
    error_count: number;
    retransmitCount?: number;
    containerId?: string;
}

interface DashboardData {
    edges: TopologyEdge[];
    total_ebpf_events: number;
    drops: { standard: number; critical: number };
    golden_signals: GoldenSignal[];
    uptime_seconds: number;
    source: string;
}

export interface GoldenSignal {
    service: string;
    rate_rps: number;
    error_pct: number;
    avg_latency_ms: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    throughput_kbps: number;
    sparkline?: number[];
    http_rate_rps?: number;
    http_error_pct?: number;
    http_2xx?: number;
    http_3xx?: number;
    http_4xx?: number;
    http_5xx?: number;
}

interface Props {
    /** URL to fetch dashboard data from */
    dataUrl?: string;
    /** Polling interval in ms */
    pollInterval?: number;
}

// ── Custom hooks ─────────────────────────────────────────────────────

function useAnimationLoop(
    canvasRef: RefObject<HTMLCanvasElement | null>,
    rendererRef: MutableRefObject<TopologyRenderer | null>,
) {
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        if (canvasRef.current && !rendererRef.current) {
            rendererRef.current = createTopologyRenderer(canvasRef.current);
            let lastTime = performance.now();

            const animate = (now: number) => {
                const renderer = rendererRef.current;
                if (renderer) {
                    renderer.simulate(now - lastTime);
                    renderer.draw();
                }
                lastTime = now;
                rafRef.current = requestAnimationFrame(animate);
            };
            rafRef.current = requestAnimationFrame(animate);
        }
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);
}

function useDataFeeder(
    data: DashboardData | null,
    rendererRef: MutableRefObject<TopologyRenderer | null>,
) {
    useEffect(() => {
        if (data && rendererRef.current && data.edges.length > 0) {
            const renderEdges: RenderEdge[] = data.edges.map(e => ({
                source: e.source,
                target: e.target,
                hitCount: e.hit_count,
                avgLatencyUs: e.latency_us,
                errorCount: e.error_count,
                retransmitCount: e.retransmitCount || 0,
                containerId: e.containerId || "",
            }));
            rendererRef.current.update(renderEdges);
        }
    }, [data]);
}

function useWebGpuDetection() {
    const [available, setAvailable] = useState<boolean | null>(null);

    useEffect(() => {
        if (typeof navigator !== "undefined" && "gpu" in navigator) {
            navigator.gpu.requestAdapter().then(
                (adapter: unknown) => setAvailable(adapter !== null),
                () => setAvailable(false),
            );
        } else {
            setAvailable(false);
        }
    }, []);

    return available;
}

function useTopologyData(dataUrl: string, pollInterval: number) {
    const [data, setData] = useState<DashboardData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [consecutiveFailures, setConsecutiveFailures] = useState(0);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(dataUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json() as DashboardData;
            setData(json);
            setError(null);
            setConsecutiveFailures(0);
        } catch (err) {
            setConsecutiveFailures(c => c + 1);
            setError((err as Error).message);
        }
    }, [dataUrl]);

    useEffect(() => {
        fetchData();
        const timer = setInterval(fetchData, pollInterval);
        return () => clearInterval(timer);
    }, [fetchData, pollInterval]);

    return { data, error, consecutiveFailures };
}

// ── Sub-components ───────────────────────────────────────────────────

function WebGpuBanner({ webGpuAvailable }: { webGpuAvailable: boolean | null }) {
    if (webGpuAvailable !== false) return null;
    return (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 bg-yellow-950/80 border border-yellow-700/50 rounded text-yellow-400 text-xs font-mono">
            WebGPU unavailable — rendering via Canvas 2D fallback
        </div>
    );
}

function RetransmitBadge({ edges }: { edges: TopologyEdge[] }) {
    const totalRetransmits = edges.reduce((sum, e) => sum + (e.retransmitCount || 0), 0);
    if (totalRetransmits === 0) return null;
    const totalHits = edges.reduce((sum, e) => sum + e.hit_count, 0) || 1;
    const rate = ((totalRetransmits / totalHits) * 100).toFixed(1);
    const className = parseFloat(rate) > 1 ? "text-red-400" : "text-yellow-400";
    return <span className={className}>⚡ {rate}% retransmit</span>;
}

// ── Render helpers ───────────────────────────────────────────────────

function renderEbpfUnavailable() {
    return (
        <div className="flex items-center justify-center h-64 bg-amber-950/20 rounded-lg border border-amber-800/40 p-4">
            <p className="text-amber-400 font-mono text-sm text-center max-w-xl">
                {EBPF_UNAVAILABLE_MSG}
            </p>
        </div>
    );
}

function renderError(error: string) {
    return (
        <div className="flex items-center justify-center h-64 bg-red-950/20 rounded-lg border border-red-900/30">
            <p className="text-red-400 font-mono text-sm">Dashboard unavailable: {error}</p>
        </div>
    );
}

function renderNoServicesDiscovered() {
    return (
        <div className="flex items-center justify-center h-64 bg-slate-900/30 rounded-lg border border-slate-800 p-4">
            <p className="text-slate-400 font-mono text-sm text-center max-w-xl">
                {NO_SERVICES_DISCOVERED_MSG}
            </p>
        </div>
    );
}

function renderNoEdgesObserved() {
    return (
        <div className="flex items-center justify-center h-64 bg-slate-900/30 rounded-lg border border-slate-800 p-4">
            <p className="text-slate-400 font-mono text-sm text-center max-w-xl">
                {NO_EDGES_OBSERVED_MSG}
            </p>
        </div>
    );
}

function renderTopologyGraph(
    data: DashboardData,
    webGpuAvailable: boolean | null,
    containerRef: RefObject<HTMLDivElement | null>,
    canvasRef: RefObject<HTMLCanvasElement | null>,
) {
    return (
        <div ref={containerRef} className="relative w-full h-full min-h-[400px] bg-[#050510] rounded-lg border border-indigo-500/10">
            <WebGpuBanner webGpuAvailable={webGpuAvailable} />
            <div className="absolute top-2 left-4 z-10 flex gap-4 text-xs font-mono text-slate-400 bg-slate-950/70 px-3 py-1.5 rounded">
                <span>{data.edges.length} edges</span>
                <span>{data.golden_signals.length} services</span>
                <span className="text-green-400">{data.total_ebpf_events.toLocaleString()} events</span>
                <RetransmitBadge edges={data.edges} />
                {data.drops.standard > 0 && (
                    <span className="text-yellow-400">⚠ {data.drops.standard} drops</span>
                )}
            </div>
            <canvas
                ref={canvasRef}
                className="w-full h-full min-h-[400px]"
                width={800}
                height={500}
            />
        </div>
    );
}

function renderLoading(containerRef: RefObject<HTMLDivElement | null>) {
    return (
        <div ref={containerRef} className="relative w-full h-full min-h-[400px] bg-[#050510] rounded-lg border border-indigo-500/10">
            <div className="flex items-center justify-center h-64">
                <div className="animate-pulse text-slate-600 font-mono text-sm">Loading topology...</div>
            </div>
        </div>
    );
}

/**
 * Live topology graph component. Fetches dashboard data on an interval
 * and renders an interactive service dependency map.
 *
 * This is the React shell. The WebGPU/Canvas renderer lives in a separate
 * module (`topology-renderer.ts`) for tree-shaking and testability.
 */
export function TopologyGraph({ dataUrl = "/v1/dashboard/data", pollInterval = 500 }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<TopologyRenderer | null>(null);

    const { data, error, consecutiveFailures } = useTopologyData(dataUrl, pollInterval);
    const webGpuAvailable = useWebGpuDetection();
    useAnimationLoop(canvasRef, rendererRef);
    useDataFeeder(data, rendererRef);

    // ── Empty / error states ────────────────────────────────────────

    if (error && data === null) {
        return renderError(error);
    }

    if (data === null && consecutiveFailures >= 3) {
        return renderEbpfUnavailable();
    }

    if (data) {
        if (data.source === "none") {
            return renderNoServicesDiscovered();
        }

        if (data.edges.length === 0) {
            return renderNoEdgesObserved();
        }

        return renderTopologyGraph(data, webGpuAvailable, containerRef, canvasRef);
    }

    return renderLoading(containerRef);
}
