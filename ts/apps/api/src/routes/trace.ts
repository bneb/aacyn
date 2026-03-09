/**
 * Trace Query Route — GET /query/trace/:traceId
 *
 * Builds a span tree from stored spans — O(n) in span count.
 * Each span's children array shows parent/child relationships
 * for waterfall visualization. Max depth is capped at 100 to
 * prevent stack overflow from degenerate trees.
 */

import { Elysia } from "elysia";
import { withStore } from "../lib/store-init";
import type { SpanNode, TraceTreeResponse } from "@aacyn/sdk";

const MAX_DEPTH = 100;

// ─── Tree Builder ─────────────────────────────────────────────────────────

/** Create a SpanNode from a raw span record. Generates hex spanIds for spans missing one. */
function makeNode(s: {
    spanId?: string; parentSpanId?: string; service: string;
    durationMs: number; isError: boolean; timestamp: number;
    method?: string; statusCode?: number; path?: string;
}): SpanNode {
    const sid = s.spanId
        || Math.floor(Math.random() * 0xffffffffffffffff).toString(16).padStart(16, "0");
    return {
        spanId: sid,
        parentSpanId: s.parentSpanId || null,
        service: s.service, durationMs: s.durationMs,
        isError: s.isError, timestamp: s.timestamp,
        method: s.method, statusCode: s.statusCode, path: s.path,
        children: [],
    };
}

/** Recursively sort children by timestamp, respecting depth limit. */
function sortSpanChildren(nodes: SpanNode[], depth: number): void {
    if (depth >= MAX_DEPTH) return;
    nodes.sort((a, b) => a.timestamp - b.timestamp);
    for (const n of nodes) sortSpanChildren(n.children, depth + 1);
}

/** @internal exported for testing */
export function buildSpanTree(
    spans: { traceId: string; spanId?: string; parentSpanId?: string;
        service: string; durationMs: number; isError: boolean; timestamp: number;
        method?: string; statusCode?: number; path?: string; }[],
): SpanNode[] {
    if (spans.length === 0) return [];

    const nodeMap = new Map<string, SpanNode>();
    const spanIds = new Set<string>();

    for (const s of spans) {
        const node = makeNode(s);
        spanIds.add(node.spanId);
        nodeMap.set(node.spanId, node);
    }

    const roots: SpanNode[] = [];
    for (const node of nodeMap.values()) {
        if (node.parentSpanId && spanIds.has(node.parentSpanId)) {
            const parent = nodeMap.get(node.parentSpanId);
            if (parent) { parent.children.push(node); continue; }
        }
        roots.push(node);
    }

    sortSpanChildren(roots, 0);
    return roots;
}

/** @internal exported for testing */
export function computeTotalDuration(roots: SpanNode[]): number {
    if (roots.length === 0) return 0;
    let minTs = Infinity, maxTs = -Infinity;
    function walk(nodes: SpanNode[], depth: number): void {
        if (depth >= MAX_DEPTH) return;
        for (const n of nodes) {
            if (n.timestamp < minTs) minTs = n.timestamp;
            if (n.timestamp + n.durationMs > maxTs) maxTs = n.timestamp + n.durationMs;
            walk(n.children, depth + 1);
        }
    }
    walk(roots, 0);
    return maxTs > minTs ? maxTs - minTs : 0;
}

// ─── Route ────────────────────────────────────────────────────────────────

export const traceRoutes = new Elysia()
    .use(withStore)
    .get(
    "/query/trace/:traceId",
    ({ params, set, store }) => {
        const spans = store.getTraceSpans?.(params.traceId);

        if (!spans || spans.length === 0) {
            set.status = 404;
            return {
                error: `Trace "${params.traceId}" not found. Traces may have been`
                    + ` garbage collected from the ring buffer, or the trace ID is incorrect.`,
                traceId: params.traceId,
            };
        }

        const tree = buildSpanTree(spans);
        const totalDurationMs = computeTotalDuration(tree);

        return {
            traceId: params.traceId,
            totalDurationMs,
            spanCount: spans.length,
            spans: tree,
        } satisfies TraceTreeResponse;
    },
);