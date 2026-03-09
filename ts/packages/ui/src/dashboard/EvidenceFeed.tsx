"use client";

import type { TopologyEdge } from "./TopologyGraph";

// ── Exported empty-state messages (testable constants) ──────────────

export const WAITING_FOR_KERNEL_EVENTS_MSG =
	"Waiting for kernel events — eBPF probes capture TCP connect() and sendmsg() syscalls at the kernel level. Generate HTTP or database traffic between your services to populate this feed with real-time kernel events.";

// ── Helpers ─────────────────────────────────────────────────────────

/** Empty state shown when no kernel events have been captured. */
function renderEmptyState() {
	return (
		<div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
			<h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">eBPF Evidence</h3>
			<p className="text-sm text-slate-600 mb-3">{WAITING_FOR_KERNEL_EVENTS_MSG}</p>
			<pre className="text-xs bg-slate-950/80 border border-slate-800 rounded p-3 font-mono text-green-400 overflow-x-auto">
{`# Generate traffic between services
curl http://your-service:8080/api/endpoint
curl -X POST http://your-service:8080/api/data -d '{"key":"value"}'`}
			</pre>
		</div>
	);
}

/** A single kernel-event row in the evidence feed. */
function renderEventItem(edge: TopologyEdge, index: number) {
	return (
		<div key={index} className="flex items-center gap-2 text-xs font-mono">
			<span className="text-slate-600 w-12 flex-shrink-0">
				{edge.error_count > 0 ? "\u{1f534}" : "\u{1f7e2}"}
			</span>
			<span className="text-indigo-400">{edge.source}</span>
			<span className="text-slate-600">\u{2192}</span>
			<span className="text-slate-300">{edge.target}</span>
			<span className="text-slate-600 ml-auto">
				{edge.latency_us}µs{" "}
				{edge.hit_count > 0 && (
					<span className="text-slate-500">\u{d7}{edge.hit_count}</span>
				)}
			</span>
		</div>
	);
}

/** List of kernel events with counts. */
function renderEventList(edges: TopologyEdge[], count: number) {
	return (
		<div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
			<h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
				eBPF Evidence{" "}
				<span className="text-slate-600 font-normal">({count} events)</span>
			</h3>
			<div className="space-y-1 max-h-64 overflow-y-auto">
				{edges.map((edge, i) => renderEventItem(edge, i))}
			</div>
		</div>
	);
}

// ── Component ──────────────────────────────────────────────────────

interface Props {
	edges: TopologyEdge[];
	maxItems?: number;
}

export function EvidenceFeed({ edges, maxItems = 20 }: Props) {
	const recentEdges = edges.slice(-maxItems);

	if (recentEdges.length === 0) {
		return renderEmptyState();
	}

	return renderEventList(recentEdges, recentEdges.length);
}
