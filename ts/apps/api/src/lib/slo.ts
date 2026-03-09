/**
 * SLO Tracking — Error Budget & Burn Rate
 *
 * Implements the Google SRE workbook multi-window burn rate model.
 * Each SLO defines a target over a window. Error budgets are consumed
 * by failing requests and slow requests. Burn rate alerts fire when
 * the budget is being consumed faster than the threshold allows.
 *
 * Reference: https://sre.google/workbook/alerting-on-slos/
 */

import { createLogger } from "./logger";
const log = createLogger("lib-slo");

// ── Types ───────────────────────────────────────────────────────────────

export interface SloDefinition {
    /** Human-readable name shown in the dashboard */
    name: string;
    /** Service this SLO applies to */
    service: string;
    /** Target as a percentage, e.g. 99.9 for three nines */
    targetPct: number;
    /** Observation window in hours (typically 28 days = 672h) */
    windowHours: number;
    /** What metric to measure against */
    metric: "latency" | "error_rate" | "throughput";
    /** Threshold for the metric — values above this count as "bad" */
    threshold: number;
    /** Unit label for display */
    unit: string;
}

export interface SloState {
    definition: SloDefinition;
    /** Total events observed in the current window */
    totalEvents: number;
    /** Events that violated the threshold ("bad" events) */
    badEvents: number;
    /** Current error budget remaining (0-1, where 1 = full budget) */
    budgetRemaining: number;
    /** Short-window burn rate (events in last 1h / budgeted events for 1h) */
    burnRate1h: number;
    /** Long-window burn rate (events in last 6h / budgeted events for 6h) */
    burnRate6h: number;
}

interface SlidingWindow {
    /** Timestamp → bad event count for that bucket */
    buckets: Map<number, number>;
    bucketSizeMs: number;
    windowSizeMs: number;
    totalBad: number;
}

// ── Constants ───────────────────────────────────────────────────────────

/** Default SLOs shipped with aacyn. Production services should define their own. */
export const DEFAULT_SLOS: SloDefinition[] = [
    {
        name: "API Latency",
        service: "*",
        targetPct: 99.9,
        windowHours: 672,
        metric: "latency",
        threshold: 100,
        unit: "ms",
    },
    {
        name: "Error Rate",
        service: "*",
        targetPct: 99.95,
        windowHours: 672,
        metric: "error_rate",
        threshold: 1,
        unit: "%",
    },
];

// ── Helpers ─────────────────────────────────────────────────────────────

/** Total events allowed to be "bad" given a target and total count. */
export function errorBudget(targetPct: number, totalEvents: number): number {
    return Math.max(0, Math.round(totalEvents * ((100 - targetPct) / 100)));
}

/** How many "bad" events per hour are budgeted for a target and event rate. */
export function budgetedBadPerHour(targetPct: number, eventsPerHour: number): number {
    return eventsPerHour * ((100 - targetPct) / 100);
}

/** Burn rate = actual bad events / budgeted bad events for a time window. */
export function burnRate(actualBad: number, budgetedBad: number): number {
    if (budgetedBad <= 0) return actualBad > 0 ? Infinity : 0;
    return actualBad / budgetedBad;
}

// ── Sliding window ──────────────────────────────────────────────────────

function createWindow(windowMs: number, bucketCount: number): SlidingWindow {
    return {
        buckets: new Map(),
        bucketSizeMs: Math.ceil(windowMs / bucketCount),
        windowSizeMs: windowMs,
        totalBad: 0,
    };
}

function recordBad(w: SlidingWindow, now: number, count: number): void {
    const bucket = Math.floor(now / w.bucketSizeMs) * w.bucketSizeMs;
    const existing = w.buckets.get(bucket) || 0;
    w.buckets.set(bucket, existing + count);
    w.totalBad += count;

    // Evict expired buckets
    const cutoff = now - w.windowSizeMs;
    for (const [ts, bad] of w.buckets) {
        if (ts < cutoff) {
            w.buckets.delete(ts);
            w.totalBad -= bad;
        }
    }
}

function badInWindow(w: SlidingWindow, windowMs: number, now: number): number {
    const cutoff = now - windowMs;
    let total = 0;
    for (const [ts, bad] of w.buckets) {
        if (ts >= cutoff) total += bad;
    }
    return total;
}

// ── SLO Engine ──────────────────────────────────────────────────────────

/** Burn rate alert thresholds (Google SRE workbook Table 5-4). */
const BURN_ALERTS: { rate: number; window: number; label: string }[] = [
    { rate: 14.4, window: 3600_000, label: "critical-1h" },
    { rate: 6.0,  window: 21600_000, label: "warning-6h" },
];

export class SloEngine {
    private slos: SloDefinition[] = [];
    private perSlo = new Map<string, {
        shortWindow: SlidingWindow;
        longWindow: SlidingWindow;
        totalEvents: number;
        badEvents: number;
        hourStart: number;
        hourCount: number;
        eventsPerHour: number;
    }>();

    // SLO state initialized lazily in define() or on first record()

    /** Define or update SLOs. Replaces the current set. */
    define(slos: SloDefinition[]): void {
        this.slos = slos;
        // Preserve existing state for SLOs that are being redefined
        const oldState = this.perSlo;
        this.perSlo = new Map();
        const now = Date.now();
        for (const slo of slos) {
            const key = sloKey(slo);
            const existing = oldState.get(key);
            if (existing) {
                this.perSlo.set(key, existing);
            } else {
                this.perSlo.set(key, {
                    shortWindow: createWindow(3600_000, 60),
                    longWindow: createWindow(21600_000, 360),
                    totalEvents: 0,
                    badEvents: 0,
                    hourStart: now,
                    hourCount: 0,
                    eventsPerHour: 0,
                });
            }
        }
        log.info(`[SLO] ${slos.length} SLOs defined`);
    }

    /** Get the per-SLO state for a definition, creating it if needed. */
    private stateFor(slo: SloDefinition) {
        const key = sloKey(slo);
        let s = this.perSlo.get(key);
        if (!s) {
            const now = Date.now();
            s = {
                shortWindow: createWindow(3600_000, 60),
                longWindow: createWindow(21600_000, 360),
                totalEvents: 0,
                badEvents: 0,
                hourStart: now,
                hourCount: 0,
                eventsPerHour: 0,
            };
            this.perSlo.set(key, s);
        }
        return s;
    }

    /** Record an observation — a request or event with a metric value. */
    record(service: string, metric: "latency" | "error_rate" | "throughput", value: number): void {
        const now = Date.now();

        for (const slo of this.slos) {
            if (slo.service !== "*" && slo.service !== service) continue;
            if (slo.metric !== metric) continue;

            const state = this.stateFor(slo);
            state.totalEvents++;

            // Track events per hour for budget calculation
            if (now - state.hourStart >= 3600_000) {
                state.eventsPerHour = state.hourCount;
                state.hourCount = 0;
                state.hourStart = now;
            }
            state.hourCount++;

            const isBad = value > slo.threshold;
            if (isBad) {
                state.badEvents++;
                recordBad(state.shortWindow, now, 1);
                recordBad(state.longWindow, now, 1);
            }
        }
    }

    /** Get the current state for a specific SLO definition. */
    status(slo: SloDefinition): SloState {
        const now = Date.now();
        const state = this.stateFor(slo);
        const budget = errorBudget(slo.targetPct, Math.max(1, state.totalEvents));
        const consumed = state.badEvents;
        const remaining = Math.max(0, budget - consumed);
        const budgetPerHour = budgetedBadPerHour(slo.targetPct, Math.max(1, state.eventsPerHour));

        return {
            definition: slo,
            totalEvents: state.totalEvents,
            badEvents: state.badEvents,
            budgetRemaining: budget > 0 ? remaining / budget : 1,
            burnRate1h: burnRate(badInWindow(state.shortWindow, 3600_000, now), budgetPerHour),
            burnRate6h: burnRate(badInWindow(state.longWindow, 21600_000, now), budgetPerHour * 6),
        };
    }

    /** List all SLO states. */
    all(): SloState[] {
        return this.slos.map(slo => this.status(slo));
    }

    /** Check for burn rate alerts. Returns any firing alert labels. */
    checkBurnAlerts(): { slo: SloDefinition; state: SloState; alert: string }[] {
        const firing: { slo: SloDefinition; state: SloState; alert: string }[] = [];
        for (const slo of this.slos) {
            const s = this.status(slo);
            for (const ba of BURN_ALERTS) {
                const rate = ba.window === 3600_000 ? s.burnRate1h : s.burnRate6h;
                if (rate >= ba.rate) {
                    firing.push({ slo, state: s, alert: ba.label });
                }
            }
        }
        return firing;
    }

    /** Reset all counters — useful when window rolls over. */
    reset(): void {
        const now = Date.now();
        for (const key of this.perSlo.keys()) {
            this.perSlo.set(key, {
                shortWindow: createWindow(3600_000, 60),
                longWindow: createWindow(21600_000, 360),
                totalEvents: 0,
                badEvents: 0,
                hourStart: now,
                hourCount: 0,
                eventsPerHour: 0,
            });
        }
    }
}

/** Unique key for an SLO definition — used for per-SLO state tracking. */
function sloKey(slo: SloDefinition): string {
    return `${slo.service}:${slo.metric}:${slo.name}`;
}
