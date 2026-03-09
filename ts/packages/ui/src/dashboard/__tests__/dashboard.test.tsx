/**
 * Dashboard Tests — Physics, State Management, and API Contract
 *
 * Tests the core logic that powers the topology dashboard:
 *   - Force-directed graph physics (repulsion, springs, convergence)
 *   - State management (node extraction, edge deduplication)
 *   - API response parsing
 */

import { describe, test, expect } from "bun:test";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TopologyNode {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
}

interface TopologyEdge {
    source: string;
    target: string;
    latency_us: number;
    hit_count: number;
}

interface TopologyUpdateData {
    edges: TopologyEdge[];
    total_ebpf_events: number;
    source: string;
}

interface GoldenSignalEdge {
    source: string;
    target: string;
    hit_count: number;
    latency_us: number;
    bytes_transferred: number;
    error_count: number;
}

interface GoldenSignals {
    service: string;
    rate_rps: number;
    error_pct: number;
    avg_latency_ms: number;
    throughput_kbps: number;
}

interface Drops {
    standard: number;
    critical: number;
}

// ─── Inline Physics Engine (mirrors dashboard.ts inline code) ────────────────

class GraphPhysics {
    repulsion = 8000;
    springK = 0.004;
    springLength = 160;
    damping = 0.88;
    centerGravity = 0.01;

    step(nodes: TopologyNode[], edges: TopologyEdge[], cx: number, cy: number): void {
        const n = nodes.length;
        if (n === 0) return;
        this.applyRepulsion(nodes, n);
        this.applySpringForces(nodes, edges);
        this.applyCenterGravity(nodes, cx, cy);
        this.integrate(nodes);
    }

    private applyRepulsion(nodes: TopologyNode[], n: number): void {
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = nodes[i];
                const b = nodes[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const distSq = dx * dx + dy * dy + 1;
                const dist = Math.sqrt(distSq);
                const force = this.repulsion / distSq;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx += fx;
                a.vy += fy;
                b.vx -= fx;
                b.vy -= fy;
            }
        }
    }

    private applySpringForces(nodes: TopologyNode[], edges: TopologyEdge[]): void {
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        for (const edge of edges) {
            const a = nodeMap.get(edge.source);
            const b = nodeMap.get(edge.target);
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
            const displacement = dist - this.springLength;
            const force = this.springK * displacement;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
        }
    }

    private applyCenterGravity(nodes: TopologyNode[], cx: number, cy: number): void {
        for (const node of nodes) {
            node.vx += (cx - node.x) * this.centerGravity;
            node.vy += (cy - node.y) * this.centerGravity;
        }
    }

    private integrate(nodes: TopologyNode[]): void {
        for (const node of nodes) {
            node.vx *= this.damping;
            node.vy *= this.damping;
            node.x += node.vx;
            node.y += node.vy;
        }
    }
}

// ─── Inline State Manager (mirrors dashboard.ts inline code) ─────────────────

class TopologyState {
    nodes: Map<string, TopologyNode> = new Map();
    edges: TopologyEdge[] = [];
    totalEvents: number = 0;
    source: string = "none";

    update(data: TopologyUpdateData) {
        if (!data || !data.edges) return;
        this.totalEvents = data.total_ebpf_events || 0;
        this.source = data.source || "none";
        this.edges = data.edges;

        const seen = new Set<string>();
        for (const e of data.edges) {
            seen.add(e.source);
            seen.add(e.target);
        }

        for (const id of seen) {
            if (!this.nodes.has(id)) {
                this.nodes.set(id, {
                    id, x: 0, y: 0, vx: 0, vy: 0,
                });
            }
        }

        for (const [id] of this.nodes) {
            if (!seen.has(id)) this.nodes.delete(id);
        }
    }

    getNodes(): TopologyNode[] { return Array.from(this.nodes.values()); }
    getEdges(): TopologyEdge[] { return this.edges; }
}

// ─── Shared Helper Functions ─────────────────────────────────────────────────

function latencyColor(us: number): string {
    if (us < 500) return "green";
    if (us < 2000) return "yellow";
    return "red";
}

function backpressureLevel(drops: Drops): string {
    if (drops.critical > 0) return "critical";
    if (drops.standard > 0) return "warning";
    return "healthy";
}

/**
 * Compute Golden Signals per target service from edge data.
 * Aggregates all edges targeting the same service.
 *
 * @param edges - topology edges with throughput/error data
 * @param uptimeSeconds - how long the engine has been collecting
 */
function computeGoldenSignals(edges: GoldenSignalEdge[], uptimeSeconds: number): GoldenSignals[] {
    if (uptimeSeconds <= 0) return [];

    // Aggregate per-target
    const byTarget = new Map<string, {
        hits: number;
        errors: number;
        latencyUs: number;
        bytes: number;
    }>();

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
            rate_rps: Math.round((data.hits / uptimeSeconds) * 100) / 100,
            error_pct: total > 0 ? Math.round((data.errors / total) * 10000) / 100 : 0,
            avg_latency_ms: data.hits > 0
                ? Math.round((data.latencyUs / data.hits) / 1000 * 100) / 100
                : 0,
            throughput_kbps: Math.round((data.bytes / uptimeSeconds / 1024) * 100) / 100,
        });
    }

    return signals.sort((a, b) => b.rate_rps - a.rate_rps);
}

function signalColor(metric: "error_pct" | "avg_latency_ms", value: number): string {
    if (metric === "error_pct") {
        if (value === 0) return "green";
        if (value < 5) return "yellow";
        return "red";
    }
    if (value < 50) return "green";
    if (value < 200) return "yellow";
    return "red";
}

// ─── Test Data ───────────────────────────────────────────────────────────────

const TOPOLOGY_MOCK_DATA: TopologyUpdateData = {
    edges: [
        { source: "nginx", target: "api (node)", latency_us: 145, hit_count: 20 },
        { source: "node", target: "db (postgres)", latency_us: 122, hit_count: 20 },
        { source: "curl", target: "aacyn-sidecar", latency_us: 274, hit_count: 8 },
    ],
    total_ebpf_events: 773,
    source: "ebpf",
};

const GOLDEN_SIGNAL_EDGES: GoldenSignalEdge[] = [
    { source: "nginx", target: "node", hit_count: 100, latency_us: 2500, bytes_transferred: 512000, error_count: 0 },
    { source: "node", target: "db (postgres)", hit_count: 100, latency_us: 1500, bytes_transferred: 204800, error_count: 2 },
    { source: "curl", target: "aacyn-sidecar", hit_count: 50, latency_us: 300, bytes_transferred: 25600, error_count: 0 },
];

const GS_UPTIME = 60;

// ─── Extracted Test Functions — GraphPhysics ────────────────────────────────

function testGraphPhysicsRepulsion(): void {
    const physics = new GraphPhysics();
    const nodes: TopologyNode[] = [
        { id: "a", x: 0, y: 0, vx: 0, vy: 0 },
        { id: "b", x: 1, y: 0, vx: 0, vy: 0 },
    ];
    for (let i = 0; i < 50; i++) physics.step(nodes, [], 0, 0);
    const dist = Math.sqrt(
        (nodes[0].x - nodes[1].x) ** 2 + (nodes[0].y - nodes[1].y) ** 2
    );
    expect(dist).toBeGreaterThan(100);
}

function testGraphPhysicsSprings(): void {
    const physics = new GraphPhysics();
    const nodes: TopologyNode[] = [
        { id: "a", x: -500, y: 0, vx: 0, vy: 0 },
        { id: "b", x: 500, y: 0, vx: 0, vy: 0 },
    ];
    const edges: TopologyEdge[] = [
        { source: "a", target: "b", latency_us: 100, hit_count: 10 },
    ];
    const initialDist = Math.abs(nodes[0].x - nodes[1].x);
    for (let i = 0; i < 100; i++) physics.step(nodes, edges, 0, 0);
    const finalDist = Math.abs(nodes[0].x - nodes[1].x);
    expect(finalDist).toBeLessThan(initialDist);
}

function testGraphPhysicsConvergence(): void {
    const physics = new GraphPhysics();
    const nodes: TopologyNode[] = [
        { id: "nginx", x: 100, y: 50, vx: 0, vy: 0 },
        { id: "api", x: -50, y: -80, vx: 0, vy: 0 },
        { id: "db", x: -200, y: 100, vx: 0, vy: 0 },
    ];
    const edges: TopologyEdge[] = [
        { source: "nginx", target: "api", latency_us: 145, hit_count: 20 },
        { source: "api", target: "db", latency_us: 122, hit_count: 20 },
    ];
    for (let i = 0; i < 300; i++) physics.step(nodes, edges, 0, 0);
    for (const node of nodes) {
        expect(Math.abs(node.vx)).toBeLessThan(0.5);
        expect(Math.abs(node.vy)).toBeLessThan(0.5);
    }
}

function testGraphPhysicsCenterGravity(): void {
    const physics = new GraphPhysics();
    const nodes: TopologyNode[] = [{ id: "a", x: 1000, y: 1000, vx: 0, vy: 0 }];
    for (let i = 0; i < 200; i++) physics.step(nodes, [], 0, 0);
    expect(Math.abs(nodes[0].x)).toBeLessThan(100);
    expect(Math.abs(nodes[0].y)).toBeLessThan(100);
}

// ─── Extracted Test Functions — TopologyState ────────────────────────────────

function testTopologyStateExtractsNodes(): void {
    const state = new TopologyState();
    state.update(TOPOLOGY_MOCK_DATA);
    const nodes = state.getNodes();
    const ids = nodes.map(n => n.id).sort();
    expect(ids).toEqual([
        "aacyn-sidecar", "api (node)", "curl", "db (postgres)", "nginx", "node",
    ]);
}

function testTopologyStatePreservesEdges(): void {
    const state = new TopologyState();
    state.update(TOPOLOGY_MOCK_DATA);
    expect(state.getEdges()).toHaveLength(3);
    expect(state.totalEvents).toBe(773);
    expect(state.source).toBe("ebpf");
}

function testTopologyStateRemovesStaleNodes(): void {
    const state = new TopologyState();
    state.update(TOPOLOGY_MOCK_DATA);
    expect(state.nodes.has("curl")).toBe(true);
    state.update({
        edges: [{ source: "nginx", target: "api (node)", latency_us: 100, hit_count: 30 }],
        total_ebpf_events: 1000,
        source: "ebpf",
    });
    expect(state.nodes.has("curl")).toBe(false);
    expect(state.nodes.has("nginx")).toBe(true);
    expect(state.nodes.has("api (node)")).toBe(true);
    expect(state.getNodes()).toHaveLength(2);
}

function testTopologyStatePreservesPositions(): void {
    const state = new TopologyState();
    state.update(TOPOLOGY_MOCK_DATA);
    const nginx = state.nodes.get("nginx")!;
    nginx.x = 42;
    nginx.y = 99;
    state.update(TOPOLOGY_MOCK_DATA);
    const updated = state.nodes.get("nginx")!;
    expect(updated.x).toBe(42);
    expect(updated.y).toBe(99);
}

function testTopologyStateHandlesNull(): void {
    const state = new TopologyState();
    state.update(null as unknown as TopologyUpdateData);
    expect(state.getNodes()).toHaveLength(0);
    state.update({ edges: [], total_ebpf_events: 0, source: "none" });
    expect(state.getNodes()).toHaveLength(0);
}

// ─── Extracted Test Functions — API Contract ────────────────────────────────

const API_MOCK_RESPONSE = {
    edges: [
        { source: "nginx", target: "api (node)", latency_us: 145, protocol: "tcp", hit_count: 20, dest_ip: "172.18.0.3", dest_port: 3000 },
    ],
    total_ebpf_events: 773,
    source: "ebpf",
};

function testApiContractSchema(): void {
    expect(API_MOCK_RESPONSE.edges).toBeArray();
    expect(API_MOCK_RESPONSE.edges[0]).toHaveProperty("source");
    expect(API_MOCK_RESPONSE.edges[0]).toHaveProperty("target");
    expect(API_MOCK_RESPONSE.edges[0]).toHaveProperty("latency_us");
    expect(API_MOCK_RESPONSE.edges[0]).toHaveProperty("hit_count");
    expect(typeof API_MOCK_RESPONSE.total_ebpf_events).toBe("number");
    expect(typeof API_MOCK_RESPONSE.source).toBe("string");
}

function testLatencyColorClassify(): void {
    expect(latencyColor(100)).toBe("green");
    expect(latencyColor(499)).toBe("green");
    expect(latencyColor(500)).toBe("yellow");
    expect(latencyColor(1999)).toBe("yellow");
    expect(latencyColor(2000)).toBe("red");
    expect(latencyColor(10000)).toBe("red");
}

const V2_DROPS_RESPONSE = {
    edges: [
        { source: "nginx", target: "api (node)", latency_us: 145, protocol: "tcp", hit_count: 20, dest_ip: "172.18.0.3", dest_port: 3000 },
    ],
    total_ebpf_events: 14409,
    drops: { standard: 142, critical: 0 },
    source: "ebpf",
};

function testApiContractV2Drops(): void {
    expect(V2_DROPS_RESPONSE).toHaveProperty("drops");
    expect(V2_DROPS_RESPONSE.drops).toHaveProperty("standard");
    expect(V2_DROPS_RESPONSE.drops).toHaveProperty("critical");
    expect(typeof V2_DROPS_RESPONSE.drops.standard).toBe("number");
    expect(typeof V2_DROPS_RESPONSE.drops.critical).toBe("number");
    expect(V2_DROPS_RESPONSE.drops.standard).toBeGreaterThanOrEqual(0);
    expect(V2_DROPS_RESPONSE.drops.critical).toBeGreaterThanOrEqual(0);
}

function testBackpressureClassification(): void {
    expect(backpressureLevel({ standard: 0, critical: 0 })).toBe("healthy");
    expect(backpressureLevel({ standard: 142, critical: 0 })).toBe("warning");
    expect(backpressureLevel({ standard: 0, critical: 1 })).toBe("critical");
    expect(backpressureLevel({ standard: 500, critical: 3 })).toBe("critical");
}

// ─── Extracted Test Functions — Golden Signals ──────────────────────────────

function testGoldenSignalsRateRps(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, GS_UPTIME);
    const node = signals.find(s => s.service === "node");
    expect(node).toBeDefined();
    expect(node!.rate_rps).toBeCloseTo(1.67, 1);
}

function testGoldenSignalsErrorPctZero(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, GS_UPTIME);
    const node = signals.find(s => s.service === "node");
    expect(node!.error_pct).toBe(0);
}

function testGoldenSignalsErrorPctComputes(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, GS_UPTIME);
    const db = signals.find(s => s.service === "db (postgres)");
    expect(db).toBeDefined();
    expect(db!.error_pct).toBeCloseTo(1.96, 0);
}

function testGoldenSignalsThroughput(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, GS_UPTIME);
    const node = signals.find(s => s.service === "node");
    expect(node!.throughput_kbps).toBeCloseTo(8.33, 0);
}

function testGoldenSignalsAvgLatency(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, GS_UPTIME);
    const node = signals.find(s => s.service === "node");
    expect(node!.avg_latency_ms).toBeCloseTo(2.5, 1);
}

function testGoldenSignalsZeroUptime(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, 0);
    expect(signals).toEqual([]);
}

function testGoldenSignalsEmptyEdges(): void {
    const signals = computeGoldenSignals([], GS_UPTIME);
    expect(signals).toEqual([]);
}

function testGoldenSignalsSorting(): void {
    const signals = computeGoldenSignals(GOLDEN_SIGNAL_EDGES, GS_UPTIME);
    expect(signals.length).toBe(3);
    for (let i = 1; i < signals.length; i++) {
        expect(signals[i - 1].rate_rps).toBeGreaterThanOrEqual(signals[i].rate_rps);
    }
}

// ─── Extracted Test Functions — Signal Color Classification ─────────────────

function testSignalColorErrorPctGreen(): void {
    expect(signalColor("error_pct", 0)).toBe("green");
}

function testSignalColorErrorPctYellow(): void {
    expect(signalColor("error_pct", 2.5)).toBe("yellow");
    expect(signalColor("error_pct", 4.99)).toBe("yellow");
}

function testSignalColorErrorPctRed(): void {
    expect(signalColor("error_pct", 5)).toBe("red");
    expect(signalColor("error_pct", 50)).toBe("red");
}

function testSignalColorLatencyGreen(): void {
    expect(signalColor("avg_latency_ms", 2.5)).toBe("green");
    expect(signalColor("avg_latency_ms", 49)).toBe("green");
}

function testSignalColorLatencyYellow(): void {
    expect(signalColor("avg_latency_ms", 50)).toBe("yellow");
    expect(signalColor("avg_latency_ms", 199)).toBe("yellow");
}

function testSignalColorLatencyRed(): void {
    expect(signalColor("avg_latency_ms", 200)).toBe("red");
    expect(signalColor("avg_latency_ms", 5000)).toBe("red");
}

// ─── Extracted Test Functions — V3 API Contract ─────────────────────────────

const V3_API_RESPONSE = {
    edges: [{ source: "nginx", target: "node", latency_us: 2500, protocol: "tcp", hit_count: 100, dest_ip: "172.18.0.3", dest_port: 3000, bytes_transferred: 512000, error_count: 0 }],
    total_ebpf_events: 5000,
    drops: { standard: 0, critical: 0 },
    golden_signals: [{ service: "node", rate_rps: 1.67, error_pct: 0, avg_latency_ms: 2.5, throughput_kbps: 8.33 }],
    source: "ebpf",
};

function testV3ApiContractGoldenSignals(): void {
    expect(V3_API_RESPONSE).toHaveProperty("golden_signals");
    expect(V3_API_RESPONSE.golden_signals).toBeArray();
    expect(V3_API_RESPONSE.golden_signals[0]).toHaveProperty("service");
    expect(V3_API_RESPONSE.golden_signals[0]).toHaveProperty("rate_rps");
    expect(V3_API_RESPONSE.golden_signals[0]).toHaveProperty("error_pct");
    expect(V3_API_RESPONSE.golden_signals[0]).toHaveProperty("avg_latency_ms");
    expect(V3_API_RESPONSE.golden_signals[0]).toHaveProperty("throughput_kbps");
    expect(typeof V3_API_RESPONSE.golden_signals[0].rate_rps).toBe("number");
    expect(typeof V3_API_RESPONSE.golden_signals[0].throughput_kbps).toBe("number");
}

// ─── Test Runner Functions (describe callbacks) ──────────────────────────────

function runGraphPhysicsTests(): void {
    test("overlapping nodes are pushed apart by repulsion", testGraphPhysicsRepulsion);
    test("edge springs pull connected nodes together", testGraphPhysicsSprings);
    test("simulation converges to stable layout", testGraphPhysicsConvergence);
    test("center gravity keeps nodes near origin", testGraphPhysicsCenterGravity);
}

function runTopologyStateTests(): void {
    test("extracts unique nodes from edges", testTopologyStateExtractsNodes);
    test("preserves edge data", testTopologyStatePreservesEdges);
    test("removes stale nodes when edges change", testTopologyStateRemovesStaleNodes);
    test("preserves existing node positions on update", testTopologyStatePreservesPositions);
    test("handles empty/null data gracefully", testTopologyStateHandlesNull);
}

function runApiContractTests(): void {
    test("mock topology response matches expected schema", testApiContractSchema);
    test("latency color classification", testLatencyColorClassify);
    test("V2 topology response includes drops field", testApiContractV2Drops);
    test("backpressure classification from drop counts", testBackpressureClassification);
}

function runGoldenSignalsTests(): void {
    test("computes rate_rps from hit_count / uptime", testGoldenSignalsRateRps);
    test("error_pct is 0 when no errors", testGoldenSignalsErrorPctZero);
    test("error_pct computes correctly with errors", testGoldenSignalsErrorPctComputes);
    test("throughput_kbps computes bytes / uptime / 1024", testGoldenSignalsThroughput);
    test("avg_latency_ms computes from weighted total", testGoldenSignalsAvgLatency);
    test("handles zero uptime gracefully", testGoldenSignalsZeroUptime);
    test("handles empty edges", testGoldenSignalsEmptyEdges);
    test("sorts by rate_rps descending (busiest service first)", testGoldenSignalsSorting);
}

function runSignalColorTests(): void {
    test("error_pct: green at 0", testSignalColorErrorPctGreen);
    test("error_pct: yellow below 5%", testSignalColorErrorPctYellow);
    test("error_pct: red at 5%+", testSignalColorErrorPctRed);
    test("latency: green below 50ms", testSignalColorLatencyGreen);
    test("latency: yellow 50-200ms", testSignalColorLatencyYellow);
    test("latency: red at 200ms+", testSignalColorLatencyRed);
}

function runV3ApiContractTests(): void {
    test("topology response includes golden_signals array", testV3ApiContractGoldenSignals);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("GraphPhysics", runGraphPhysicsTests);
describe("TopologyState", runTopologyStateTests);
describe("API Contract", runApiContractTests);
describe("Golden Signals", runGoldenSignalsTests);
describe("Golden Signal Color Classification", runSignalColorTests);
describe("V3 API Contract", runV3ApiContractTests);
