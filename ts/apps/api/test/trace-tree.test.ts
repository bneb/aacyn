/**
 * Trace Tree Builder Tests
 *
 * Tests the span tree construction logic used by the trace route.
 * Validates: root detection, parent-child linking, depth ordering,
 * empty state, error state, and total duration calculation.
 */

import { test, expect, describe } from "bun:test";
import { buildSpanTree, computeTotalDuration } from "../src/routes/trace";
import type { SpanNode } from "@aacyn/sdk";

// ─── Helpers ──────────────────────────────────────────────────────────────

interface RawSpan {
    traceId: string;
    spanId?: string;
    parentSpanId?: string;
    service: string;
    durationMs: number;
    isError: boolean;
    timestamp: number;
    method?: string;
    statusCode?: number;
}

function flattenTree(nodes: SpanNode[], depth = 0): { spanId: string; depth: number }[] {
    const rows: { spanId: string; depth: number }[] = [];
    for (const n of nodes) {
        rows.push({ spanId: n.spanId, depth });
        if (n.children.length > 0) {
            rows.push(...flattenTree(n.children, depth + 1));
        }
    }
    return rows;
}

function collectSpanIds(nodes: SpanNode[]): string[] {
    const ids: string[] = [];
    function walk(ns: SpanNode[]) {
        for (const n of ns) {
            ids.push(n.spanId);
            walk(n.children);
        }
    }
    walk(nodes);
    return ids;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("buildSpanTree", () => {
    test("returns empty array for empty input", () => {
        const result = buildSpanTree([]);
        expect(result).toEqual([]);
    });

    test("single root span has no parent", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "1", service: "api", durationMs: 100, isError: false, timestamp: 1000 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree.length).toBe(1);
        expect(tree[0].spanId).toBe("1");
        expect(tree[0].parentSpanId).toBeNull();
        expect(tree[0].children.length).toBe(0);
    });

    test("two independent spans are separate roots", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "1", service: "api", durationMs: 100, isError: false, timestamp: 1000 },
            { traceId: "abc", spanId: "2", service: "auth", durationMs: 50, isError: false, timestamp: 1100 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree.length).toBe(2);
        expect(tree[0].spanId).toBe("1");
        expect(tree[1].spanId).toBe("2");
    });

    test("parent-child linking works", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "root", service: "frontend", durationMs: 200, isError: false, timestamp: 1000 },
            { traceId: "abc", spanId: "child", parentSpanId: "root", service: "auth", durationMs: 100, isError: false, timestamp: 1050 },
            { traceId: "abc", spanId: "grandchild", parentSpanId: "child", service: "db", durationMs: 50, isError: false, timestamp: 1100 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree.length).toBe(1);
        expect(tree[0].spanId).toBe("root");
        expect(tree[0].children.length).toBe(1);
        expect(tree[0].children[0].spanId).toBe("child");
        expect(tree[0].children[0].children.length).toBe(1);
        expect(tree[0].children[0].children[0].spanId).toBe("grandchild");
    });

    test("multiple children under same parent", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "root", service: "api", durationMs: 300, isError: false, timestamp: 1000 },
            { traceId: "abc", spanId: "c1", parentSpanId: "root", service: "svc1", durationMs: 100, isError: false, timestamp: 1100 },
            { traceId: "abc", spanId: "c2", parentSpanId: "root", service: "svc2", durationMs: 150, isError: false, timestamp: 1200 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree.length).toBe(1);
        expect(tree[0].children.length).toBe(2);
        expect(tree[0].children.map(c => c.spanId).sort()).toEqual(["c1", "c2"]);
    });

    test("orphan span with unknown parent becomes root", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "child", parentSpanId: "unknown-parent", service: "api", durationMs: 100, isError: false, timestamp: 1000 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree.length).toBe(1);
        expect(tree[0].parentSpanId).toBe("unknown-parent");
    });

    test("spans without spanId get generated IDs", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", service: "api", durationMs: 100, isError: false, timestamp: 1000 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree.length).toBe(1);
        expect(tree[0].spanId).toBeTruthy();
    });

    test("children sorted by timestamp", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "root", service: "api", durationMs: 300, isError: false, timestamp: 1000 },
            { traceId: "abc", spanId: "c2", parentSpanId: "root", service: "svc2", durationMs: 150, isError: false, timestamp: 1200 },
            { traceId: "abc", spanId: "c1", parentSpanId: "root", service: "svc1", durationMs: 100, isError: false, timestamp: 1100 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree[0].children.length).toBe(2);
        expect(tree[0].children[0].spanId).toBe("c1");
        expect(tree[0].children[1].spanId).toBe("c2");
    });

    test("error flag is preserved", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "1", service: "api", durationMs: 100, isError: true, timestamp: 1000 },
        ];
        const tree = buildSpanTree(spans);
        expect(tree[0].isError).toBe(true);
    });
});

describe("computeTotalDuration", () => {
    test("returns 0 for empty tree", () => {
        expect(computeTotalDuration([])).toBe(0);
    });

    test("returns duration for single span", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "1", service: "api", durationMs: 100, isError: false, timestamp: 1000 },
        ];
        const tree = buildSpanTree(spans);
        expect(computeTotalDuration(tree)).toBe(100);
    });

    test("computes span over entire tree range", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "1", service: "api", durationMs: 200, isError: false, timestamp: 1000 },
            { traceId: "abc", spanId: "2", parentSpanId: "1", service: "auth", durationMs: 50, isError: false, timestamp: 1100 },
        ];
        const tree = buildSpanTree(spans);
        const total = computeTotalDuration(tree);
        expect(total).toBeGreaterThanOrEqual(200);
    });
});

describe("flattenTree", () => {
    test("depth increases with nesting", () => {
        const spans: RawSpan[] = [
            { traceId: "abc", spanId: "1", service: "api", durationMs: 100, isError: false, timestamp: 1000 },
            { traceId: "abc", spanId: "2", parentSpanId: "1", service: "auth", durationMs: 50, isError: false, timestamp: 1100 },
            { traceId: "abc", spanId: "3", parentSpanId: "2", service: "db", durationMs: 25, isError: false, timestamp: 1150 },
        ];
        const tree = buildSpanTree(spans);
        const flat = flattenTree(tree);
        expect(flat).toEqual([
            { spanId: "1", depth: 0 },
            { spanId: "2", depth: 1 },
            { spanId: "3", depth: 2 },
        ]);
    });
});