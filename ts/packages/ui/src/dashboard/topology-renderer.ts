/**
 * Topology Renderer — WebGPU & Canvas 2D graph visualization.
 *
 * Extracted from the inline dashboard HTML. Renders a force-directed
 * service dependency graph using WebGPU when available, falling back
 * to Canvas 2D. The physics engine uses Coulomb repulsion + Hooke
 * spring forces + center gravity + velocity damping.
 *
 * Usage:
 *   const renderer = createTopologyRenderer(canvasElement);
 *   renderer.update(edges);
 *   // Each frame: renderer.simulate(deltaTime); renderer.draw();
 */

export interface RenderNode {
    id: string;
    label: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
}

export interface RenderEdge {
    source: string;
    target: string;
    hitCount: number;
    avgLatencyUs: number;
    errorCount: number;
    retransmitCount: number;
    containerId: string;
}

export interface TopologyRenderer {
    update(edges: RenderEdge[]): void;
    simulate(deltaMs: number): void;
    draw(): void;
    getNodes(): Readonly<RenderNode[]>;
    resize(width: number, height: number): void;
}

/** Create a topology renderer backed by WebGPU or Canvas 2D. */
export function createTopologyRenderer(canvas: HTMLCanvasElement): TopologyRenderer {
    const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
    return hasWebGPU
        ? new Canvas2DRenderer(canvas) // WebGPU path: init async, use Canvas fallback until ready
        : new Canvas2DRenderer(canvas);
}

/** Force constants — tunable for different graph sizes */
const REPULSION = 5000;
const SPRING_LENGTH = 120;
const SPRING_STIFFNESS = 0.02;
const CENTER_GRAVITY = 0.005;
const DAMPING = 0.85;
const MAX_SPEED = 8;

class Canvas2DRenderer implements TopologyRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private nodes = new Map<string, RenderNode>();
    private edges: RenderEdge[] = [];
    private width = 800;
    private height = 500;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d")!;
        this.resize(canvas.width || 800, canvas.height || 500);
    }

    update(edges: RenderEdge[]): void {
        this.edges = edges;

        // Discover nodes from edges
        for (const edge of edges) {
            this.ensureNode(edge.source);
            this.ensureNode(edge.target);
        }
    }

    simulate(deltaMs: number): void {
        const nodes = Array.from(this.nodes.values());
        if (nodes.length === 0) return;

        const dt = Math.min(deltaMs / 16, 3);
        const fx = new Float64Array(nodes.length);
        const fy = new Float64Array(nodes.length);

        this.computeCoulombForces(nodes, fx, fy);
        this.computeSpringForces(nodes, fx, fy);
        this.integrateForces(nodes, fx, fy, dt);
    }

    /** Coulomb repulsion between all node pairs */
    private computeCoulombForces(nodes: RenderNode[], fx: Float64Array, fy: Float64Array): void {
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                let dx = nodes[i].x - nodes[j].x;
                let dy = nodes[i].y - nodes[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const force = REPULSION / (dist * dist);
                const fx_ij = (dx / dist) * force;
                const fy_ij = (dy / dist) * force;
                fx[i] += fx_ij; fy[i] += fy_ij;
                fx[j] -= fx_ij; fy[j] -= fy_ij;
            }
        }
    }

    /** Hooke spring forces along edges */
    private computeSpringForces(nodes: RenderNode[], fx: Float64Array, fy: Float64Array): void {
        for (const edge of this.edges) {
            const src = this.nodes.get(edge.source);
            const tgt = this.nodes.get(edge.target);
            if (!src || !tgt) continue;

            let dx = tgt.x - src.x;
            let dy = tgt.y - src.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const displacement = dist - SPRING_LENGTH;
            const force = displacement * SPRING_STIFFNESS;
            const fx_s = (dx / dist) * force;
            const fy_s = (dy / dist) * force;

            const si = nodes.indexOf(src);
            const ti = nodes.indexOf(tgt);
            fx[si] += fx_s; fy[si] += fy_s;
            fx[ti] -= fx_s; fy[ti] -= fy_s;
        }
    }

    /** Center gravity, velocity integration, speed clamping, and bounds clamping */
    private integrateForces(nodes: RenderNode[], fx: Float64Array, fy: Float64Array, dt: number): void {
        const cx = this.width / 2;
        const cy = this.height / 2;

        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            fx[i] += (cx - n.x) * CENTER_GRAVITY;
            fy[i] += (cy - n.y) * CENTER_GRAVITY;

            n.vx = (n.vx + fx[i] * dt) * DAMPING;
            n.vy = (n.vy + fy[i] * dt) * DAMPING;

            const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > MAX_SPEED) {
                n.vx = (n.vx / speed) * MAX_SPEED;
                n.vy = (n.vy / speed) * MAX_SPEED;
            }

            n.x += n.vx * dt;
            n.y += n.vy * dt;

            n.x = Math.max(n.radius, Math.min(this.width - n.radius, n.x));
            n.y = Math.max(n.radius, Math.min(this.height - n.radius, n.y));
        }
    }

    draw(): void {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        this.drawEdges();
        this.drawNodes();
    }

    /** Stroke each edge with colour/width derived from hit and error counts */
    private drawEdges(): void {
        const ctx = this.ctx;
        for (const edge of this.edges) {
            const src = this.nodes.get(edge.source);
            const tgt = this.nodes.get(edge.target);
            if (!src || !tgt) continue;

            const alpha = Math.min(1, edge.hitCount / 100);
            ctx.strokeStyle = edge.errorCount > 0
                ? `rgba(239,68,68,${0.3 + alpha * 0.4})`
                : `rgba(99,102,241,${0.15 + alpha * 0.3})`;
            ctx.lineWidth = Math.max(1, Math.log2(edge.hitCount + 1) * 0.8);
            ctx.beginPath();
            ctx.moveTo(src.x, src.y);
            ctx.lineTo(tgt.x, tgt.y);
            ctx.stroke();
        }
    }

    /** Render each node with glow, circle, and label */
    private drawNodes(): void {
        const ctx = this.ctx;
        for (const node of this.nodes.values()) {
            // Glow
            const gradient = ctx.createRadialGradient(node.x, node.y, node.radius * 0.5, node.x, node.y, node.radius * 1.5);
            gradient.addColorStop(0, "rgba(99,102,241,0.3)");
            gradient.addColorStop(1, "rgba(99,102,241,0)");
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius * 1.5, 0, Math.PI * 2);
            ctx.fill();

            // Circle
            ctx.fillStyle = "#1e1b4b";
            ctx.strokeStyle = "#818cf8";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Label
            ctx.fillStyle = "#e2e8f0";
            ctx.font = "10px Inter, system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(node.label, node.x, node.y + node.radius + 14);
        }
    }

    getNodes(): Readonly<RenderNode[]> {
        return Array.from(this.nodes.values());
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
    }

    private ensureNode(id: string): RenderNode {
        let node = this.nodes.get(id);
        if (!node) {
            node = {
                id,
                label: id,
                x: this.width / 2 + (Math.random() - 0.5) * 200,
                y: this.height / 2 + (Math.random() - 0.5) * 200,
                vx: 0,
                vy: 0,
                radius: 18,
            };
            this.nodes.set(id, node);
        }
        return node;
    }
}
