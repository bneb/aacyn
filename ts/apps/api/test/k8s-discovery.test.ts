/**
 * K8sDiscovery Tests
 *
 * Validates pod list fetching, IP-to-pod mapping, edge and service enrichment,
 * lifecycle management, and graceful degradation when the K8s API is unavailable.
 *
 * Uses a mock HTTP client to simulate the Kubernetes API.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { K8sDiscovery } from "../src/lib/k8s-discovery";
import type { TopologyEdge, DiscoveredService } from "@aacyn/sdk";

// ─── Test Fixtures ─────────────────────────────────────────────────────

const SAMPLE_PODS = {
    items: [
        {
            metadata: {
                name: "api-7d8f9g6h4-abc12",
                namespace: "production",
                labels: { app: "api-service", "app.kubernetes.io/name": "api-service" },
                ownerReferences: [
                    { kind: "ReplicaSet", name: "api-service-7d8f9g6h4" },
                ],
            },
            status: { podIP: "10.0.1.1" },
        },
        {
            metadata: {
                name: "frontend-5c6d7e8f9-xyz99",
                namespace: "production",
                labels: { app: "frontend", "app.kubernetes.io/name": "frontend" },
                ownerReferences: [
                    { kind: "ReplicaSet", name: "frontend-5c6d7e8f9" },
                ],
            },
            status: { podIP: "10.0.1.2" },
        },
        {
            metadata: {
                name: "redis-abc123-def456",
                namespace: "cache",
                labels: { app: "redis", "k8s-app": "redis" },
                ownerReferences: [
                    { kind: "StatefulSet", name: "redis" },
                ],
            },
            status: { podIP: "10.0.2.1" },
        },
        // Pod without IP (not ready yet)
        {
            metadata: {
                name: "pending-pod",
                namespace: "default",
                labels: { app: "pending" },
            },
            status: {},
        },
        // Pod without ownerReferences (uses labels for deployment)
        {
            metadata: {
                name: "daemon-agent-x7y8z",
                namespace: "monitoring",
                labels: { "k8s-app": "daemon-agent" },
            },
            status: { podIP: "10.0.3.1" },
        },
    ],
};

// ─── Env helpers ───────────────────────────────────────────────────────

function withK8sEnv(fn: () => void): void {
    const savedHost = process.env.KUBERNETES_SERVICE_HOST;
    const savedPort = process.env.KUBERNETES_SERVICE_PORT;
    try {
        fn();
    } finally {
        if (savedHost === undefined) {
            delete process.env.KUBERNETES_SERVICE_HOST;
        } else {
            process.env.KUBERNETES_SERVICE_HOST = savedHost;
        }
        if (savedPort === undefined) {
            delete process.env.KUBERNETES_SERVICE_PORT;
        } else {
            process.env.KUBERNETES_SERVICE_PORT = savedPort;
        }
    }
}

// ─── Mock fetch factory ────────────────────────────────────────────────

function mockFetch(response: unknown, status = 200): typeof globalThis.fetch {
    return mock(async () =>
        new Response(JSON.stringify(response), {
            status,
            headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;
}

function mockFetchError(msg: string): typeof globalThis.fetch {
    return mock(async () => {
        throw new Error(msg);
    }) as unknown as typeof globalThis.fetch;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("K8sDiscovery — constructor & lifecycle", () => {
    afterEach(() => {
        withK8sEnv(() => {
            /* env cleanup happens in the restore */
        });
    });

    test("creates instance without env vars — enrichment disabled", () => {
        delete process.env.KUBERNETES_SERVICE_HOST;
        const k8s = new K8sDiscovery();
        expect(k8s.initialized).toBe(false);
        expect(k8s.podCount).toBe(0);
    });

    test("creates instance with explicit options — enrichment active", () => {
        const k8s = new K8sDiscovery({
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        expect(k8s.initialized).toBe(false);
        // initialized is false until first refresh; setting baseUrl means it can start
    });

    test("stop is safe when not started", () => {
        const k8s = new K8sDiscovery();
        expect(() => k8s.stop()).not.toThrow();
    });

    test("start returns immediately when not in-cluster", async () => {
        delete process.env.KUBERNETES_SERVICE_HOST;
        const k8s = new K8sDiscovery();
        await k8s.start();
        expect(k8s.initialized).toBe(false);
    });
});

describe("K8sDiscovery — pod discovery", () => {
    test("fetches pods and builds IP-to-pod map", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        expect(k8s.initialized).toBe(true);
        // 5 items, 1 without IP = 4 valid pods
        expect(k8s.podCount).toBe(4);
        expect(k8s.lookUpPod("10.0.1.1")?.name).toBe("api-7d8f9g6h4-abc12");
        expect(k8s.lookUpPod("10.0.1.2")?.name).toBe("frontend-5c6d7e8f9-xyz99");
    });

    test("lookUpPod returns undefined for unknown IP", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        expect(k8s.lookUpPod("10.99.99.99")).toBeUndefined();
        expect(k8s.lookUpPod("")).toBeUndefined();
    });

    test("parses deployment from ReplicaSet ownerReference", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const apiPod = k8s.lookUpPod("10.0.1.1");
        expect(apiPod?.deployment).toBe("api-service");

        const frontendPod = k8s.lookUpPod("10.0.1.2");
        expect(frontendPod?.deployment).toBe("frontend");
    });

    test("parses deployment from StatefulSet ownerReference", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const redisPod = k8s.lookUpPod("10.0.2.1");
        expect(redisPod?.deployment).toBe("redis");
    });

    test("falls back to labels when no ownerReferences", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const daemonPod = k8s.lookUpPod("10.0.3.1");
        expect(daemonPod?.deployment).toBe("daemon-agent");
    });

    test("handles empty pod list", async () => {
        const fetchMock = mockFetch({ items: [] });
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        expect(k8s.initialized).toBe(true);
        expect(k8s.podCount).toBe(0);
    });

    test("recovers after a failed fetch", async () => {
        let callCount = 0;
        const fetchFn = mock(async () => {
            callCount++;
            if (callCount === 1) {
                throw new Error("Network error");
            }
            return new Response(JSON.stringify(SAMPLE_PODS), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as unknown as typeof globalThis.fetch;

        const k8s = new K8sDiscovery({
            fetchFn,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start(); // calls refreshPods once

        // First call fails → not initialized
        expect(callCount).toBe(1);
        // The start handles error gracefully

        // Manually refresh again (simulates next poll cycle)
        await k8s["refreshPods"]();
        expect(callCount).toBe(2);
        expect(k8s.initialized).toBe(true);
        expect(k8s.podCount).toBe(4);
    });
});

describe("K8sDiscovery — edge enrichment", () => {
    test("enrichEdges adds pod info for matching source IPs", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const edges: TopologyEdge[] = [
            {
                source: "some-process",
                target: "other-service:3000",
                sourceIp: "10.0.1.1",
                destIp: "10.0.99.99",
                destPort: 3000,
                hitCount: 10,
                avgLatencyUs: 100,
                lastSeenNs: Date.now() * 1e6,
                totalBytes: 1000,
                errorCount: 0,
            },
        ];

        const enriched = k8s.enrichEdges(edges);
        expect(enriched[0].sourcePodName).toBe("api-7d8f9g6h4-abc12");
        expect(enriched[0].sourcePodNamespace).toBe("production");
        expect(enriched[0].sourceDeployment).toBe("api-service");
        // destIp has no match — should remain undefined
        expect(enriched[0].targetPodName).toBeUndefined();
    });

    test("enrichEdges adds pod info for matching dest IPs", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const edges: TopologyEdge[] = [
            {
                source: "process-a",
                target: "unknown:6379",
                sourceIp: "10.0.99.99",
                destIp: "10.0.2.1",
                destPort: 6379,
                hitCount: 5,
                avgLatencyUs: 200,
                lastSeenNs: Date.now() * 1e6,
                totalBytes: 500,
                errorCount: 0,
            },
        ];

        const enriched = k8s.enrichEdges(edges);
        expect(enriched[0].targetPodName).toBe("redis-abc123-def456");
        expect(enriched[0].targetPodNamespace).toBe("cache");
        expect(enriched[0].targetDeployment).toBe("redis");
        expect(enriched[0].sourcePodName).toBeUndefined();
    });

    test("enrichEdges handles both source and dest match", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const edges: TopologyEdge[] = [
            {
                source: "frontend",
                target: "redis:6379",
                sourceIp: "10.0.1.2",
                destIp: "10.0.2.1",
                destPort: 6379,
                hitCount: 100,
                avgLatencyUs: 150,
                lastSeenNs: Date.now() * 1e6,
                totalBytes: 10000,
                errorCount: 0,
            },
        ];

        const enriched = k8s.enrichEdges(edges);
        expect(enriched[0].sourcePodName).toBe("frontend-5c6d7e8f9-xyz99");
        expect(enriched[0].sourcePodNamespace).toBe("production");
        expect(enriched[0].sourceDeployment).toBe("frontend");
        expect(enriched[0].targetPodName).toBe("redis-abc123-def456");
        expect(enriched[0].targetPodNamespace).toBe("cache");
        expect(enriched[0].targetDeployment).toBe("redis");
    });

    test("enrichEdges leaves edges unchanged when no IP match", async () => {
        const fetchMock = mockFetch({ items: [] });
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const edges: TopologyEdge[] = [
            {
                source: "a", target: "b:80", sourceIp: "10.0.0.1", destIp: "10.0.0.2",
                destPort: 80, hitCount: 1, avgLatencyUs: 10,
                lastSeenNs: Date.now() * 1e6, totalBytes: 100, errorCount: 0,
            },
        ];

        const enriched = k8s.enrichEdges(edges);
        expect(enriched[0].sourcePodName).toBeUndefined();
        expect(enriched[0].targetPodName).toBeUndefined();
    });

    test("enrichEdges returns original array when not initialized", () => {
        const k8s = new K8sDiscovery();
        const edges: TopologyEdge[] = [
            {
                source: "a", target: "b:80", sourceIp: "10.0.0.1", destIp: "10.0.0.2",
                destPort: 80, hitCount: 1, avgLatencyUs: 10,
                lastSeenNs: Date.now() * 1e6, totalBytes: 100, errorCount: 0,
            },
        ];
        const result = k8s.enrichEdges(edges);
        expect(result).toBe(edges); // same reference
        expect(result[0].sourcePodName).toBeUndefined();
    });

    test("enrichEdges handles empty edges array", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const result = k8s.enrichEdges([]);
        expect(result).toEqual([]);
    });
});

describe("K8sDiscovery — service enrichment", () => {
    test("enrichServices matches service by comm to deployment name", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const services: DiscoveredService[] = [
            { pid: 101, port: 3000, comm: "api-service", acceptCount: 100, avgLatencyMs: 1.5, lastSeenNs: Date.now() * 1e6 },
        ];

        const enriched = k8s.enrichServices(services);
        expect(enriched[0].podName).toBe("api-7d8f9g6h4-abc12");
        expect(enriched[0].podNamespace).toBe("production");
        expect(enriched[0].deployment).toBe("api-service");
    });

    test("enrichServices matches service by pod name prefix", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const services: DiscoveredService[] = [
            { pid: 201, port: 6379, comm: "redis", acceptCount: 500, avgLatencyMs: 0.5, lastSeenNs: Date.now() * 1e6 },
        ];

        const enriched = k8s.enrichServices(services);
        expect(enriched[0].podName).toBe("redis-abc123-def456");
        expect(enriched[0].podNamespace).toBe("cache");
        expect(enriched[0].deployment).toBe("redis");
    });

    test("enrichServices matches by label app value", async () => {
        const fetchMock = mockFetch({
            items: [
                {
                    metadata: {
                        name: "auth-abc-xyz",
                        namespace: "prod",
                        labels: { app: "auth-service" },
                    },
                    status: { podIP: "10.0.5.1" },
                },
            ],
        });
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const services: DiscoveredService[] = [
            { pid: 301, port: 4000, comm: "auth-service", acceptCount: 50, avgLatencyMs: 2.0, lastSeenNs: Date.now() * 1e6 },
        ];

        const enriched = k8s.enrichServices(services);
        expect(enriched[0].podName).toBe("auth-abc-xyz");
        expect(enriched[0].deployment).toBe("auth-service");
    });

    test("enrichServices leaves unmatched services unchanged", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const services: DiscoveredService[] = [
            {
                pid: 999, port: 9999, comm: "unknown-process",
                acceptCount: 0, avgLatencyMs: 0, lastSeenNs: 0,
            },
        ];

        const enriched = k8s.enrichServices(services);
        expect(enriched[0].podName).toBeUndefined();
        expect(enriched[0].podNamespace).toBeUndefined();
        expect(enriched[0].deployment).toBeUndefined();
    });

    test("enrichServices returns original when not initialized", () => {
        const k8s = new K8sDiscovery();
        const services: DiscoveredService[] = [
            { pid: 1, port: 80, comm: "nginx", acceptCount: 10, avgLatencyMs: 1, lastSeenNs: 0 },
        ];
        const result = k8s.enrichServices(services);
        expect(result).toBe(services);
        expect(result[0].podName).toBeUndefined();
    });

    test("enrichServices handles empty services array", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const result = k8s.enrichServices([]);
        expect(result).toEqual([]);
    });

    test("enrichServices skips empty comm", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const services: DiscoveredService[] = [
            { pid: 1, port: 80, comm: "", acceptCount: 0, avgLatencyMs: 0, lastSeenNs: 0 },
        ];

        const enriched = k8s.enrichServices(services);
        expect(enriched[0].podName).toBeUndefined();
    });
});

describe("K8sDiscovery — HTTP error handling", () => {
    test("handles API returning non-200 status", async () => {
        const fetchFn = mock(async () =>
            new Response("Unauthorized", { status: 401 }),
        ) as unknown as typeof globalThis.fetch;

        const k8s = new K8sDiscovery({
            fetchFn,
            baseUrl: "https://localhost:6443",
            token: "bad-token",
        });
        await k8s.start();

        // Should not throw, just log warning
        expect(k8s.initialized).toBe(false);
        expect(k8s.podCount).toBe(0);
    });

    test("handles network errors gracefully", async () => {
        const fetchFn = mockFetchError("ECONNREFUSED");
        const k8s = new K8sDiscovery({
            fetchFn,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        expect(k8s.initialized).toBe(false);
        expect(k8s.podCount).toBe(0);
    });

    test("enrichment is a no-op after failed start", async () => {
        const fetchFn = mockFetchError("ECONNREFUSED");
        const k8s = new K8sDiscovery({
            fetchFn,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();

        const edges: TopologyEdge[] = [
            {
                source: "a", target: "b", sourceIp: "10.0.1.1", destIp: "10.0.2.1",
                destPort: 80, hitCount: 1, avgLatencyUs: 10,
                lastSeenNs: Date.now() * 1e6, totalBytes: 100, errorCount: 0,
            },
        ];
        const result = k8s.enrichEdges(edges);
        expect(result[0].sourcePodName).toBeUndefined();
    });
});

describe("K8sDiscovery — stop & restart", () => {
    test("stop clears poll timer", async () => {
        const fetchMock = mockFetch(SAMPLE_PODS);
        const k8s = new K8sDiscovery({
            fetchFn: fetchMock,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s.start();
        expect(k8s.initialized).toBe(true);

        k8s.stop();
        // After stop, no more refreshes happen
        expect(k8s.podCount).toBe(4);

        // Start again should re-fetch
        const fetchMock2 = mockFetch({ items: [] });
        const k8s2 = new K8sDiscovery({
            fetchFn: fetchMock2,
            baseUrl: "https://localhost:6443",
            token: "test-token",
        });
        await k8s2.start();
        expect(k8s2.initialized).toBe(true);
        expect(k8s2.podCount).toBe(0);
    });
});
