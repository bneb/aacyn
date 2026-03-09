/**
 * aacyn Dashboard — Real-Time WebGPU Topology Map
 *
 * Serves a self-contained HTML page at GET /dashboard that renders
 * eBPF-discovered microservice topology using hardware-accelerated
 * WebGPU (with Canvas 2D fallback).
 *
 * Data flow:
 *   eBPF ring buffer → C topology tracker → FFI → /v1/topology
 *   → fetch(500ms) → physics simulation → WebGPU render @ 60fps
 */

import { Elysia } from "elysia";
import { withStore } from "../lib/store-init";
import { withK8s } from "../lib/k8s-discovery";
import type { IStore, TopologyEdge } from "@aacyn/sdk";
import type { K8sDiscovery } from "../lib/k8s-discovery";
import { createLogger } from "../lib/logger";

const log = createLogger("routes:dashboard");

// ─── Response Types ───────────────────────────────────────────────────────────

interface EdgeDataItem {
    source: string;
    target: string;
    latency_us: number;
    protocol: string;
    hit_count: number;
    dest_ip: string;
    dest_port: number;
    bytes_transferred: number;
    error_count: number;
    /** Pod name for the source endpoint (from K8s enrichment) */
    source_pod_name?: string;
    /** Namespace of the source pod */
    source_pod_namespace?: string;
    /** Deployment name for the source pod */
    source_deployment?: string;
    /** Pod name for the target endpoint */
    target_pod_name?: string;
    /** Namespace of the target pod */
    target_pod_namespace?: string;
    /** Deployment name for the target pod */
    target_deployment?: string;
}

interface GoldenSignalItem {
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

export interface DashboardDataResponse {
    edges: EdgeDataItem[];
    total_ebpf_events: number;
    drops: { standard: number; critical: number };
    golden_signals: GoldenSignalItem[];
    uptime_seconds: number;
    source: string;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/** Map TopologyEdge records to the flattened edge-data wire format. */
function computeEdgeData(edges: TopologyEdge[]): EdgeDataItem[] {
    return edges.map((e) => ({
        source: e.source,
        target: e.target,
        latency_us: e.avgLatencyUs,
        protocol: "tcp",
        hit_count: e.hitCount,
        dest_ip: e.destIp,
        dest_port: e.destPort,
        bytes_transferred: e.totalBytes || 0,
        error_count: e.errorCount || 0,
        source_pod_name: e.sourcePodName,
        source_pod_namespace: e.sourcePodNamespace,
        source_deployment: e.sourceDeployment,
        target_pod_name: e.targetPodName,
        target_pod_namespace: e.targetPodNamespace,
        target_deployment: e.targetDeployment,
    }));
}

/**
 * Rolling sparkline buffer — accumulates per-service request-rate history
 * for the inline mini-charts. Capped at 120 points (60 seconds at 500ms poll).
 */
const sparklineBuffer = new Map<string, number[]>();
const SPARKLINE_MAX = 120;

function pushSparkline(service: string, rate: number): number[] {
    let buf = sparklineBuffer.get(service);
    if (!buf) {
        buf = [];
        sparklineBuffer.set(service, buf);
    }
    buf.push(rate);
    if (buf.length > SPARKLINE_MAX) buf.shift();
    return buf;
}

/** Prune sparkline entries for services that no longer appear in the topology. */
function pruneSparklines(activeServices: Set<string>): void {
    for (const key of sparklineBuffer.keys()) {
        if (!activeServices.has(key)) sparklineBuffer.delete(key);
    }
}

/**
 * Compute approximate percentile latency from weighted edge data.
 * With only avgLatencyUs per edge we approximate: p50 ~ weighted avg,
 * p95 ~ 2x weighted avg, p99 ~ 4x weighted avg.
 */
function approxPercentiles(avgLatencyMs: number): { p50: number; p95: number; p99: number } {
    return {
        p50: avgLatencyMs,
        p95: avgLatencyMs * 2,
        p99: avgLatencyMs * 4,
    };
}

/** Build signal items from per-target aggregates, tracking sparklines. */
function buildSignalsFromTargets(
    targets: Map<string, { hits: number; errors: number; latencyUs: number; bytes: number }>,
    uptime: number,
): GoldenSignalItem[] {
    const active = new Set<string>();
    const signals: GoldenSignalItem[] = [];
    for (const [service, data] of targets.entries()) {
        active.add(service);
        const avgLatencyMs = data.hits > 0 ? (data.latencyUs / data.hits) / 1000 : 0;
        const errorPct = (data.hits + data.errors) > 0 ? (data.errors / (data.hits + data.errors)) * 100 : 0;
        const rateRps = data.hits / uptime;
        const { p50, p95, p99 } = approxPercentiles(avgLatencyMs);
        signals.push({
            service, rate_rps: rateRps, error_pct: errorPct, avg_latency_ms: avgLatencyMs,
            p50_ms: p50, p95_ms: p95, p99_ms: p99,
            throughput_kbps: (data.bytes / uptime) / 1024,
            sparkline: pushSparkline(service, rateRps),
        });
    }
    pruneSparklines(active);
    return signals;
}

/** Compute per-service golden signals (rate, error %, latency ms, throughput). */
function computeGoldenSignals(edges: TopologyEdge[]): GoldenSignalItem[] {
    const uptime = Math.max(1, process.uptime());
    const byTarget = new Map<string, { hits: number; errors: number; latencyUs: number; bytes: number }>();
    for (const e of edges) {
        const n = byTarget.get(e.target) || { hits: 0, errors: 0, latencyUs: 0, bytes: 0 };
        n.hits += e.hitCount;
        n.errors += e.errorCount;
        n.latencyUs += e.avgLatencyUs * e.hitCount;
        n.bytes += e.totalBytes;
        byTarget.set(e.target, n);
    }
    return buildSignalsFromTargets(byTarget, uptime);
}

/** Assemble the full dashboard response from the store, enriched with pod data. */
function buildDashboardResponse(store: IStore, k8sDiscovery?: K8sDiscovery): DashboardDataResponse {
    const empty: DashboardDataResponse = {
        edges: [],
        total_ebpf_events: 0,
        drops: { standard: 0, critical: 0 },
        golden_signals: [],
        uptime_seconds: 0,
        source: "none",
    };

    try {
        let edges = store.topologyEdges();
        if (k8sDiscovery?.initialized) {
            edges = k8sDiscovery.enrichEdges(edges);
        }
        const drainCount = store.ebpfDrainCount();
        const drops = store.dropCounts();

        return {
            edges: computeEdgeData(edges),
            total_ebpf_events: drainCount,
            drops,
            golden_signals: computeGoldenSignals(edges),
            uptime_seconds: Math.round(Math.max(1, process.uptime())),
            source: "ebpf",
        };
    } catch (err) {
        log.warn(`[dashboard] Store unavailable, returning empty payload: ${(err as Error).message}`);
        return empty;
    }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

export const dashboardRoutes = new Elysia()
    .use(withK8s)
    .use(withStore)
    /** Dashboard data API — returns full topology + golden signals payload, enriched. */
    .get("/v1/dashboard/data", ({ store, k8sDiscovery }) =>
        buildDashboardResponse(store, k8sDiscovery)
    );
