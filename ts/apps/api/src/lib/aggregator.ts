import { createLogger } from "./logger";
const log = createLogger("lib-aggregator");

/**
 * Multi-Node Aggregator (Sprint 6 — v0.9.0)
 *
 * Central aggregation point for multi-node deployments. Each aacyn node pushes
 * its local topology + golden signals to the aggregator. The aggregator merges
 * using the existing IP-based algorithm and exposes the global view.
 *
 * Architecture:
 *   Node → POST /v1/aggregator/push → Aggregator → merge → global topology
 *
 * Startup mode:
 *   AACYN_MODE=aggregator → listens for node pushes
 *   AACYN_MODE=node AACYN_AGGREGATOR_URL=<url> → pushes to aggregator
 */

export interface NodeTopology {
    nodeId: string;
    edges: {
        source: string;
        target: string;
        sourceIp: string;
        destIp: string;
        destPort: number;
        hitCount: number;
        avgLatencyUs: number;
        totalBytes: number;
        errorCount: number;
    }[];
    services: {
        pid: number;
        port: number;
        comm: string;
        acceptCount: number;
        avgLatencyMs: number;
    }[];
    goldenSignals: {
        service: string;
        rate: number;
        errorRate: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        throughputKbps: number;
    }[];
    ebpfDrops: { standard: number; critical: number };
    timestamp: number;
}

export interface MergedTopology {
    edges: NodeTopology["edges"];
    services: NodeTopology["services"];
    goldenSignals: NodeTopology["goldenSignals"];
    totalEbpfEvents: number;
    totalDrops: { standard: number; critical: number };
    nodeCount: number;
    lastMerge: number;
}

/**
 * Multi-Node Aggregator. Receives topology pushes from N nodes and
 * produces a single merged global topology using IP correlation.
 */
export class Aggregator {
    /** Per-node latest topology snapshots, keyed by nodeId. */
    private nodes = new Map<string, NodeTopology>();

    /** Merged topology cache — rebuilt on each push. */
    private merged: MergedTopology = {
        edges: [],
        services: [],
        goldenSignals: [],
        totalEbpfEvents: 0,
        totalDrops: { standard: 0, critical: 0 },
        nodeCount: 0,
        lastMerge: 0,
    };

    /**
     * Accept a topology push from a node. Returns the merged view.
     */
    push(nodeId: string, topology: NodeTopology): MergedTopology {
        this.nodes.set(nodeId, topology);
        this.pruneStaleNodes();
        return this.merge();
    }

    private pruneStaleNodes() {
        const now = Date.now();
        for (const [id, node] of this.nodes.entries()) {
            // Prune nodes that haven't pushed in 60 seconds
            if (now - node.timestamp > 60_000) {
                this.nodes.delete(id);
            }
        }
    }

    /**
     * Remove a node (on disconnect / timeout). Returns the updated merged view.
     */
    removeNode(nodeId: string): MergedTopology {
        this.nodes.delete(nodeId);
        return this.merge();
    }

    /** Get the current merged topology without recomputing. */
    getMerged(): Readonly<MergedTopology> {
        return this.merged;
    }

    /**
     * Rebuild the merged topology from all node snapshots.
     * Uses IP-based subgraph merging — identical algorithm to the local
     * topology merge in native-store.ts, applied across nodes.
     */
    private merge(): MergedTopology {
        const { allEdges, allServices, allSignals, totalDrops } = this.collectAllNodeData();
        this.resolveIpsToServices(allEdges);
        const deduped = this.deduplicateEdges(allEdges);
        const signalByService = this.aggregateGoldenSignals(allSignals);
        return this.buildMergedResult(deduped, allServices, signalByService, totalDrops);
    }

    /**
     * Collect edges, services, golden signals, and drop counters from all nodes.
     */
    private collectAllNodeData() {
        const allEdges: NodeTopology["edges"] = [];
        const allServices: NodeTopology["services"] = [];
        const allSignals: NodeTopology["goldenSignals"] = [];
        const totalDrops = { standard: 0, critical: 0 };

        for (const [, node] of this.nodes) {
            for (const edge of node.edges) allEdges.push({ ...edge });
            for (const svc of node.services) allServices.push({ ...svc });
            for (const sig of node.goldenSignals) allSignals.push({ ...sig });
            totalDrops.standard += node.ebpfDrops.standard;
            totalDrops.critical += node.ebpfDrops.critical;
        }

        return { allEdges, allServices, allSignals, totalDrops };
    }

    /**
     * Cross-node IP-based subgraph merging. Builds a source-IP-to-service-name
     * map and resolves destination IPs in all edges to their service names.
     */
    private resolveIpsToServices(allEdges: NodeTopology["edges"]) {
        const ipToSource = new Map<string, string>();
        for (const edge of allEdges) {
            if (edge.sourceIp !== "0.0.0.0") {
                ipToSource.set(edge.sourceIp, edge.source);
            }
        }

        for (const edge of allEdges) {
            const resolvedComm = ipToSource.get(edge.destIp);
            if (resolvedComm) {
                edge.target = resolvedComm;
            }
        }
    }

    /**
     * Deduplicate edges that share the same source, target, and destPort.
     * Merges hitCount, avgLatencyUs (weighted average), totalBytes, and errorCount.
     */
    private deduplicateEdges(allEdges: NodeTopology["edges"]) {
        const edgeKey = (e: NodeTopology["edges"][0]) =>
            `${e.source}|${e.target}|${e.destPort}`;

        const deduped = new Map<string, NodeTopology["edges"][0]>();
        for (const edge of allEdges) {
            const key = edgeKey(edge);
            const existing = deduped.get(key);
            if (existing) {
                const oldHitCount = existing.hitCount;
                const newHitCount = oldHitCount + edge.hitCount;
                if (newHitCount > 0) {
                    existing.avgLatencyUs = Math.round(
                        (existing.avgLatencyUs * oldHitCount + edge.avgLatencyUs * edge.hitCount) / newHitCount
                    );
                }
                existing.hitCount = newHitCount;
                existing.totalBytes += edge.totalBytes;
                existing.errorCount += edge.errorCount;
            } else {
                deduped.set(key, { ...edge });
            }
        }

        return deduped;
    }

    /**
     * Aggregate golden signals by service name. Combines rates and throughput,
     * takes the max of error rate, p95, and p99 across nodes.
     */
    private aggregateGoldenSignals(allSignals: NodeTopology["goldenSignals"]) {
        const signalByService = new Map<string, NodeTopology["goldenSignals"][0]>();
        for (const sig of allSignals) {
            const existing = signalByService.get(sig.service);
            if (existing) {
                existing.rate += sig.rate;
                existing.errorRate = Math.max(existing.errorRate, sig.errorRate);
                existing.throughputKbps += sig.throughputKbps;
                existing.p95Ms = Math.max(existing.p95Ms, sig.p95Ms);
                existing.p99Ms = Math.max(existing.p99Ms, sig.p99Ms);
            } else {
                signalByService.set(sig.service, { ...sig });
            }
        }

        return signalByService;
    }

    /**
     * Build the final MergedTopology from the deduplicated and aggregated data.
     */
    private buildMergedResult(
        deduped: Map<string, NodeTopology["edges"][0]>,
        allServices: NodeTopology["services"],
        signalByService: Map<string, NodeTopology["goldenSignals"][0]>,
        totalDrops: { standard: number; critical: number }
    ): MergedTopology {
        this.merged = {
            edges: Array.from(deduped.values()),
            services: allServices,
            goldenSignals: Array.from(signalByService.values()),
            totalEbpfEvents: 0,
            totalDrops,
            nodeCount: this.nodes.size,
            lastMerge: Date.now(),
        };
        return this.merged;
    }
}

/**
 * Node Push Client. When running in AACYN_MODE=node, periodically pushes
 * local topology to the aggregator with exponential backoff on failure.
 */
export class NodePushClient {
    private aggregatorUrl: string;
    private nodeId: string;
    private intervalMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private consecutiveFailures = 0;

    constructor(opts: {
        aggregatorUrl: string;
        nodeId?: string;
        intervalMs?: number;
    }) {
        this.aggregatorUrl = opts.aggregatorUrl;
        this.nodeId = opts.nodeId || `node_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
        this.intervalMs = opts.intervalMs || 5000;
    }

    /** Start periodic pushes. */
    start(pushFn: () => NodeTopology): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.pushOnce(pushFn), this.intervalMs);
        this.pushOnce(pushFn); // First push immediately
    }

    private async pushOnce(pushFn: () => NodeTopology): Promise<void> {
        try {
            const topology = pushFn();
            const response = await fetch(`${this.aggregatorUrl}/v1/aggregator/push`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...topology, nodeId: this.nodeId }),
                signal: AbortSignal.timeout(10_000),
            });

            if (!response.ok) {
                const body = await response.text().catch(() => "no body");
                throw new Error(
                    `Aggregator at ${this.aggregatorUrl}/v1/aggregator/push ` +
                    `returned HTTP ${response.status}: ${body.slice(0, 200)}. ` +
                    `Check: (1) is the aggregator running? ` +
                    `(2) is AACYN_AGGREGATOR_URL correct? ` +
                    `(3) is the aggregator's /v1/aggregator/push endpoint reachable from this node?`
                );
            }

            this.consecutiveFailures = 0;
        } catch (err) {
            this.consecutiveFailures++;
            const backoff = Math.min(
                this.intervalMs * Math.pow(2, this.consecutiveFailures),
                60_000
            );
            log.warn(
                `[Aggregator] Push failed (attempt ${this.consecutiveFailures}): ` +
                `${(err as Error).message}. Next retry in ${backoff}ms`
            );
        }
    }

    /** Stop periodic pushes. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
