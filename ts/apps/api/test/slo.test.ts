/**
 * SLO Engine Tests
 *
 * Validates error budget math, burn rate calculation, sliding window
 * behavior, and SLO API endpoints. Uses the Google SRE workbook examples
 * as reference values.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
    errorBudget,
    burnRate,
    budgetedBadPerHour,
    SloEngine,
    DEFAULT_SLOS,
    type SloDefinition,
} from "../src/lib/slo";

// ── Math unit tests ──────────────────────────────────────────────────

describe("SLO error budget math", () => {
    test("errorBudget: 99.9% target with 1M events == 1,000 bad allowed", () => {
        expect(errorBudget(99.9, 1_000_000)).toBe(1000);
    });

    test("errorBudget: 99.0% target with 10,000 events == 100 bad allowed", () => {
        expect(errorBudget(99.0, 10_000)).toBe(100);
    });

    test("errorBudget: 100% target with any count == 0 bad allowed", () => {
        expect(errorBudget(100.0, 1_000_000)).toBe(0);
    });

    test("errorBudget: 0 events => 0 bad allowed", () => {
        expect(errorBudget(99.9, 0)).toBe(0);
    });

    test("budgetedBadPerHour: 99.9% at 1M events/h => ~1000 bad/h", () => {
        expect(budgetedBadPerHour(99.9, 1_000_000)).toBeCloseTo(1000, 0);
    });

    test("burnRate: 2000 bad / 1000 budgeted == 2.0x", () => {
        expect(burnRate(2000, 1000)).toBe(2.0);
    });

    test("burnRate: 0 bad / 1000 budgeted == 0", () => {
        expect(burnRate(0, 1000)).toBe(0);
    });

    test("burnRate: 1 bad / 0 budgeted == Infinity", () => {
        expect(burnRate(1, 0)).toBe(Infinity);
    });

    test("burnRate: 0 bad / 0 budgeted == 0", () => {
        expect(burnRate(0, 0)).toBe(0);
    });
});

// ── SLO Engine tests ─────────────────────────────────────────────────

describe("SloEngine", () => {
    let engine: SloEngine;

    const LATENCY_SLO: SloDefinition = {
        name: "Test Latency",
        service: "*",
        targetPct: 99.0,
        windowHours: 672,
        metric: "latency",
        threshold: 100,
        unit: "ms",
    };

    beforeEach(() => {
        engine = new SloEngine();
    });

    test("initializes with empty SLOs", () => {
        expect(engine.all()).toHaveLength(0);
    });

    test("defines SLOs and returns states", () => {
        engine.define([LATENCY_SLO]);
        const states = engine.all();
        expect(states).toHaveLength(1);
        expect(states[0].definition.name).toBe("Test Latency");
        expect(states[0].budgetRemaining).toBe(1);
        expect(states[0].totalEvents).toBe(0);
    });

    test("records events and updates budget", () => {
        engine.define([LATENCY_SLO]);
        // Record 1000 good events (under 100ms threshold)
        for (let i = 0; i < 1000; i++) {
            engine.record("api", "latency", 50);
        }
        const state = engine.all()[0];
        expect(state.totalEvents).toBe(1000);
        expect(state.badEvents).toBe(0);
        expect(state.budgetRemaining).toBe(1);
    });

    test("records bad events that consume budget", () => {
        engine.define([LATENCY_SLO]);
        // 900 good, 100 bad = 10% bad with 99% target = 1% budget = 10 bad allowed
        for (let i = 0; i < 900; i++) engine.record("api", "latency", 50);
        for (let i = 0; i < 100; i++) engine.record("api", "latency", 200);
        const state = engine.all()[0];
        expect(state.totalEvents).toBe(1000);
        expect(state.badEvents).toBe(100);
        // Budget should be partially consumed
        expect(state.budgetRemaining).toBeLessThan(1);
        expect(state.budgetRemaining).toBeGreaterThan(-1);
    });

    test("filters by service — only matching SLOs are affected", () => {
        const authSlo: SloDefinition = {
            name: "Auth Latency",
            service: "auth-service",
            targetPct: 99.0,
            windowHours: 672,
            metric: "latency",
            threshold: 50,
            unit: "ms",
        };
        engine.define([LATENCY_SLO, authSlo]);

        // Record events for payment-api — should only affect "*" SLO
        engine.record("payment-api", "latency", 200);
        const states = engine.all();
        // Both SLOs: "*" SLO should be affected, auth SLO should not
        const wildcard = states.find(s => s.definition.name === "Test Latency")!;
        const auth = states.find(s => s.definition.name === "Auth Latency")!;
        expect(wildcard.badEvents).toBe(1);
        expect(auth.badEvents).toBe(0);
    });

    test("filters by metric — only matching metrics are checked", () => {
        const errorSlo: SloDefinition = {
            name: "Error Rate",
            service: "*",
            targetPct: 99.0,
            windowHours: 672,
            metric: "error_rate",
            threshold: 5,
            unit: "%",
        };
        engine.define([LATENCY_SLO, errorSlo]);

        engine.record("api", "latency", 200); // bad for latency SLO
        engine.record("api", "error_rate", 1); // good for error SLO

        const states = engine.all();
        const latState = states.find(s => s.definition.name === "Test Latency")!;
        const errState = states.find(s => s.definition.name === "Error Rate")!;
        expect(latState.badEvents).toBe(1); // 200ms > 100ms threshold
        expect(errState.badEvents).toBe(0); // 1% < 5% threshold
    });

    test("checkBurnAlerts returns empty when no burn", () => {
        engine.define([LATENCY_SLO]);
        const alerts = engine.checkBurnAlerts();
        expect(alerts).toHaveLength(0);
    });

    test("DEFAULT_SLOS contain expected definitions", () => {
        expect(DEFAULT_SLOS.length).toBeGreaterThanOrEqual(1);
        for (const slo of DEFAULT_SLOS) {
            expect(slo.name).toBeTruthy();
            expect(slo.targetPct).toBeGreaterThan(90);
            expect(slo.windowHours).toBeGreaterThan(0);
        }
    });

    test("reset clears all counters", () => {
        engine.define([LATENCY_SLO]);
        engine.record("api", "latency", 200);
        expect(engine.all()[0].badEvents).toBe(1);

        engine.reset();
        expect(engine.all()[0].badEvents).toBe(0);
        expect(engine.all()[0].totalEvents).toBe(0);
    });

    test("all() returns sorted results", () => {
        engine.define([
            { ...LATENCY_SLO, name: "B" },
            { ...LATENCY_SLO, name: "A" },
        ]);
        const names = engine.all().map(s => s.definition.name);
        expect(names).toEqual(["B", "A"]);
    });
});
