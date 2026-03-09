/**
 * Service Auto-Discovery Route — GET /v1/services, GET /v1/topology
 *
 * Returns all services auto-discovered by eBPF kernel probes and the
 * enriched topology dependency graph. Pod metadata is added when
 * K8sDiscovery is active.
 *
 * On macOS or when eBPF is not active, returns an empty array.
 */

import { Elysia } from "elysia";
import { withStore } from "../lib/store-init";
import { withK8s } from "../lib/k8s-discovery";
import type { TopologyEdge } from "@aacyn/sdk";
import { createLogger } from "../lib/logger";
const log = createLogger("routes-discovery");

/* ── Engine uptime tracking for rate calculations ─────────────────────────── */
const engineStartMs = Date.now();

function uptimeSeconds(): number {
    return Math.max(1, (Date.now() - engineStartMs) / 1000);
}

/* ── Golden Signals computation ───────────────────────────────────────────── */
export interface GoldenSignals {
    service: string;
    rate_rps: number;
    error_pct: number;
    avg_latency_ms: number;
    throughput_kbps: number;
}

function computeGoldenSignals(
    edges: { target: string; hit_count: number; latency_us: number; bytes_transferred: number; error_count: number }[],
    uptime: number,
): GoldenSignals[] {
    if (uptime <= 0 || edges.length === 0) return [];

    const byTarget = new Map<string, { hits: number; errors: number; latencyUs: number; bytes: number }>();
    for (const e of edges) {
        const existing = byTarget.get(e.target) || { hits: 0, errors: 0, latencyUs: 0, bytes: 0 };
        existing.hits += e.hit_count;
        existing.errors += e.error_count;
        existing.latencyUs += e.latency_us * e.hit_count;
        existing.bytes += e.bytes_transferred;
        byTarget.set(e.target, existing);
    }

    const signals: GoldenSignals[] = [];
    for (const [service, data] of byTarget) {
        const total = data.hits + data.errors;
        signals.push({
            service,
            rate_rps: Math.round((data.hits / uptime) * 100) / 100,
            error_pct: total > 0 ? Math.round((data.errors / total) * 10000) / 100 : 0,
            avg_latency_ms: data.hits > 0
                ? Math.round((data.latencyUs / data.hits) / 1000 * 100) / 100
                : 0,
            throughput_kbps: Math.round((data.bytes / uptime / 1024) * 100) / 100,
        });
    }

    return signals.sort((a, b) => b.rate_rps - a.rate_rps);
}

/* ── Topology Edge mapping ────────────────────────────────────────────────── */

export interface TopologyEdgeResponse {
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
    /** gRPC service:method name if this edge carries gRPC traffic */
    grpc_service?: string;
}

function mapTopologyEdge(e: TopologyEdge): TopologyEdgeResponse {
    return {
        source: e.source,
        target: e.target,
        latency_us: e.avgLatencyUs,
        protocol: e.grpcService ? "grpc" : "tcp",
        hit_count: e.hitCount,
        dest_ip: e.destIp,
        dest_port: e.destPort,
        bytes_transferred: e.totalBytes || 0,
        error_count: e.errorCount || 0,
        grpc_service: e.grpcService,
        source_pod_name: e.sourcePodName,
        source_pod_namespace: e.sourcePodNamespace,
        source_deployment: e.sourceDeployment,
        target_pod_name: e.targetPodName,
        target_pod_namespace: e.targetPodNamespace,
        target_deployment: e.targetDeployment,
    };
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

export const discoveryRoutes = new Elysia()
    .use(withK8s)
    .use(withStore)
    /**
     * List auto-discovered services
     * Returns golden signals: accept count, avg latency, port, PID
     * Pod metadata is added when K8sDiscovery is active.
     */
    .get("/v1/services", ({ store, k8sDiscovery }) => {
        try {
            let services = store.discoveredServices();
            if (k8sDiscovery?.initialized) {
                services = k8sDiscovery.enrichServices(services);
            }
            return {
                services,
                count: services.length,
                source: "ebpf",
            };
        } catch (e) {
            log.error({ error: (e as Error).message }, "Failed to fetch discovered services");
        }

        return {
            services: [],
            count: 0,
            source: "none",
            hint: "eBPF probes not active. Run on Linux with CAP_BPF.",
        };
    })
    /**
     * Topology graph — eBPF-discovered service dependency map
     * Returns edges enriched with pod metadata from K8sDiscovery.
     */
    .get("/v1/topology", ({ store, k8sDiscovery }) => {
        try {
            let edges = store.topologyEdges();
            if (k8sDiscovery?.initialized) {
                edges = k8sDiscovery.enrichEdges(edges);
            }
            const drainCount = store.ebpfDrainCount();
            const drops = store.dropCounts();
            const edgeData = edges.map(mapTopologyEdge);

            return {
                edges: edgeData,
                total_ebpf_events: drainCount,
                drops,
                golden_signals: computeGoldenSignals(edgeData, uptimeSeconds()),
                uptime_seconds: Math.round(uptimeSeconds()),
                source: "ebpf",
            };
        } catch (e) {
            log.error({ error: (e as Error).message }, "Failed to fetch topology");
        }

        return {
            edges: [],
            total_ebpf_events: 0,
            drops: { standard: 0, critical: 0 },
            golden_signals: [],
            uptime_seconds: 0,
            source: "none",
            hint: "eBPF probes not active. Run on Linux with CAP_BPF.",
        };
    });
