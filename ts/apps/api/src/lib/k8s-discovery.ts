/**
 * Kubernetes Pod Discovery & Enrichment
 *
 * Watches Kubernetes pods via the API server and builds an IP-to-pod
 * mapping. Provides enrichment functions that add pod metadata (name,
 * namespace, deployment) to topology edges and discovered services.
 *
 * In-cluster auto-detection: reads KUBERNETES_SERVICE_HOST / _PORT and
 * the service account token from the standard filesystem paths.
 * Falls back gracefully when not in a K8s cluster.
 *
 * Usage (server.ts):
 *   const k8s = new K8sDiscovery();
 *   await k8s.start();
 *   app.decorate("k8sDiscovery", k8s);
 *
 * Routes access via:
 *   .use(withK8s)
 *   .get("/path", ({ k8sDiscovery }) => { ... })
 */

import { Elysia } from "elysia";
import { readFileSync } from "node:fs";
import { createLogger } from "./logger";
import type { TopologyEdge, DiscoveredService } from "@aacyn/sdk";

const log = createLogger("k8s-discovery");

// ── Types ──────────────────────────────────────────────────────────────

export interface PodInfo {
    name: string;
    namespace: string;
    podIp: string;
    labels: Record<string, string>;
    deployment?: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface K8sDiscoveryOptions {
    /** Custom HTTP fetch function (injectable for tests) */
    fetchFn?: FetchFn;
    /** Base URL for K8s API (e.g. https://localhost:6443) */
    baseUrl?: string;
    /** Service account token for K8s API auth */
    token?: string;
}

interface K8sOwnerRef {
    kind?: string;
    name?: string;
}

interface K8sPodObject {
    metadata?: {
        name?: string;
        namespace?: string;
        labels?: Record<string, string>;
        ownerReferences?: K8sOwnerRef[];
    };
    status?: {
        podIP?: string;
    };
}

interface K8sPodList {
    items: K8sPodObject[];
}

// ── K8sDiscovery ───────────────────────────────────────────────────────

export class K8sDiscovery {
    private podMap = new Map<string, PodInfo>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private baseUrl = "";
    private token = "";
    private httpFn: FetchFn;
    private _initialized = false;

    constructor(opts?: K8sDiscoveryOptions) {
        this.httpFn = opts?.fetchFn || globalThis.fetch.bind(globalThis);

        if (opts?.baseUrl) {
            this.baseUrl = opts.baseUrl;
            this.token = opts?.token || "";
            return;
        }

        const host = process.env.KUBERNETES_SERVICE_HOST;
        if (!host) return;

        const port = process.env.KUBERNETES_SERVICE_PORT || "443";
        this.baseUrl = `https://${host}:${port}`;
        try {
            this.token = readFileSync(
                "/var/run/secrets/kubernetes.io/serviceaccount/token",
                "utf8",
            ).trim();
        } catch {
            log.warn("No K8s SA token found — pod enrichment disabled");
            this.baseUrl = "";
        }
    }

    /** True after at least one successful pod list fetch. */
    get initialized(): boolean {
        return this._initialized;
    }

    /** Number of pods currently tracked. */
    get podCount(): number {
        return this.podMap.size;
    }

    /**
     * Start the pod watcher. Fetches immediately, then polls on the given
     * interval. Resolves after the first fetch completes (success or error).
     */
    async start(pollIntervalMs = 30000): Promise<void> {
        if (!this.baseUrl) return;
        log.info(`Starting K8s pod watcher (interval=${pollIntervalMs}ms)`);
        await this.refreshPods();
        this.pollTimer = setInterval(
            () => this.refreshPods(),
            pollIntervalMs,
        );
        if (this.pollTimer?.unref) this.pollTimer.unref();
    }

    /** Stop the pod watcher and clear the poll timer. */
    stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Look up a pod by its cluster IP. Returns undefined if not found. */
    lookUpPod(ip: string): PodInfo | undefined {
        return this.podMap.get(ip);
    }

    /**
     * Enrich topology edges with pod metadata. For each edge, looks up
     * sourceIp and destIp in the pod map and sets pod name, namespace,
     * and deployment fields. Modifies edges in-place and returns the
     * same array for chaining.
     */
    enrichEdges(edges: TopologyEdge[]): TopologyEdge[] {
        if (!this._initialized) return edges;
        for (const edge of edges) {
            const srcPod = this.podMap.get(edge.sourceIp);
            const dstPod = this.podMap.get(edge.destIp);
            if (srcPod) {
                edge.sourcePodName = srcPod.name;
                edge.sourcePodNamespace = srcPod.namespace;
                edge.sourceDeployment = srcPod.deployment;
            }
            if (dstPod) {
                edge.targetPodName = dstPod.name;
                edge.targetPodNamespace = dstPod.namespace;
                edge.targetDeployment = dstPod.deployment;
            }
        }
        return edges;
    }

    /**
     * Enrich discovered services with pod metadata. Uses best-effort
     * matching: compares the service comm (process name) against pod
     * deployment names, container names, and pod name prefixes.
     * Modifies services in-place and returns the same array.
     */
    enrichServices(services: DiscoveredService[]): DiscoveredService[] {
        if (!this._initialized || services.length === 0) return services;
        for (const svc of services) {
            const pod = this.findPodByComm(svc.comm);
            if (pod) {
                svc.podName = pod.name;
                svc.podNamespace = pod.namespace;
                svc.deployment = pod.deployment;
            }
        }
        return services;
    }

    /**
     * Best-effort pod lookup by process comm name.
     * Tries: exact deployment match, container name match, pod name prefix,
     * and app label match.
     */
    private findPodByComm(comm: string): PodInfo | undefined {
        if (!comm) return undefined;
        const lower = comm.toLowerCase();
        let candidate: PodInfo | undefined;
        for (const pod of this.podMap.values()) {
            if (
                pod.deployment === comm ||
                pod.deployment?.toLowerCase() === lower
            ) {
                return pod;
            }
            if (pod.name.startsWith(comm) || pod.name.startsWith(lower)) {
                candidate = pod;
            }
            if (
                pod.labels["app"] === comm ||
                pod.labels["app.kubernetes.io/name"] === comm
            ) {
                candidate = pod;
            }
        }
        return candidate;
    }

    /** Fetch pod list from K8s API and rebuild the internal map. */
    private async refreshPods(): Promise<void> {
        try {
            const response = await this.fetchPods();
            this.podMap.clear();
            for (const item of response.items) {
                const pod = this.parsePodItem(item);
                if (pod) this.podMap.set(pod.podIp, pod);
            }
            this._initialized = true;
            log.info(`Discovered ${this.podMap.size} pods`);
        } catch (err) {
            log.warn("K8s pod refresh failed: " + (err as Error).message);
        }
    }

    /** HTTP GET /api/v1/pods from the K8s API server. */
    private async fetchPods(): Promise<K8sPodList> {
        const resp = await this.httpFn(
            `${this.baseUrl}/api/v1/pods?limit=500`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: "application/json",
                },
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (!resp.ok) {
            throw new Error(
                `K8s API /api/v1/pods returned HTTP ${resp.status}`,
            );
        }
        return resp.json() as Promise<K8sPodList>;
    }

    /** Parse a single K8s pod object into a PodInfo record. */
    private parsePodItem(item: K8sPodObject): PodInfo | null {
        const podIp = item?.status?.podIP;
        if (!podIp) return null;

        const meta = item?.metadata;
        const name: string = meta?.name || "";
        const namespace: string = meta?.namespace || "default";
        const labels: Record<string, string> = meta?.labels || {};

        let deployment: string | undefined;
        const ownerRefs = meta?.ownerReferences || [];
        for (const ref of ownerRefs) {
            if (ref.kind === "ReplicaSet" && ref.name) {
                const match = ref.name.match(/^(.*)-[a-z0-9]+$/);
                if (match) deployment = match[1];
            } else if (
                ref.kind === "DaemonSet" ||
                ref.kind === "StatefulSet"
            ) {
                deployment = ref.name;
            }
        }
        if (!deployment) {
            deployment =
                labels["app.kubernetes.io/name"] ||
                labels["app"] ||
                labels["k8s-app"];
        }

        return { name, namespace, podIp, labels, deployment };
    }
}

// ── Elysia Plugin ──────────────────────────────────────────────────────
// Provides type-safe `k8sDiscovery` injection for route handlers.
// The actual instance is decorated at the app level in server.ts.

export const withK8s = new Elysia({ name: "with-k8s" }).decorate(
    "k8sDiscovery",
    null as unknown as K8sDiscovery,
);
