/**
 * Tests for the TOML rule compiler
 */

import { describe, test, expect } from "bun:test";
import { compileRules, parseConfig, type FilterRule } from "../src/lib/rules";

describe("compileRules - basic", () => {
    test("compiles a drop-by-duration rule to 16 bytes", () => {
        const rules: FilterRule[] = [
            { column: "duration", op: "lt", threshold: 1.0, action: "drop" },
        ];

        const { buffer, count } = compileRules(rules);

        expect(count).toBe(1);
        expect(buffer.byteLength).toBe(16);

        const view = new DataView(buffer.buffer);
        expect(view.getUint8(0)).toBe(0);  // column = duration
        expect(view.getUint8(1)).toBe(0);  // op = lt
        expect(view.getUint8(2)).toBe(0);  // action = drop
        expect(view.getFloat64(4, true)).toBeCloseTo(1.0, 5);
    });

    test("supports symbolic operators", () => {
        const rules: FilterRule[] = [
            { column: "duration", op: "<", threshold: 5.0, action: "drop" },
            { column: "duration", op: ">=", threshold: 100.0, action: "drop" },
        ];

        const { buffer, count } = compileRules(rules);
        const view = new DataView(buffer.buffer);

        expect(count).toBe(2);
        expect(view.getUint8(1)).toBe(0);   // < = LT
        expect(view.getUint8(17)).toBe(5);  // >= = GTE
    });
});

describe("compileRules - multiple", () => {
    test("compiles multiple rules", () => {
        const rules: FilterRule[] = [
            { column: "duration", op: "lt", threshold: 1.0, action: "drop" },
            { column: "is_error", op: "eq", threshold: 0, action: "drop" },
            { column: "duration", op: "gt", threshold: 10000, action: "drop" },
        ];

        const { buffer, count } = compileRules(rules);

        expect(count).toBe(3);
        expect(buffer.byteLength).toBe(48); // 3 * 16

        // Verify second rule
        const view = new DataView(buffer.buffer);
        expect(view.getUint8(16 + 0)).toBe(1);  // column = is_error
        expect(view.getUint8(16 + 1)).toBe(2);  // op = eq
        expect(view.getUint8(16 + 2)).toBe(0);  // action = drop
        expect(view.getFloat64(16 + 4, true)).toBeCloseTo(0, 5);
    });
});

describe("compileRules - validation", () => {
    test("throws on invalid column", () => {
        expect(() =>
            compileRules([{ column: "bogus", op: "lt", threshold: 1, action: "drop" }])
        ).toThrow("Unknown column");
    });

    test("throws on invalid op", () => {
        expect(() =>
            compileRules([{ column: "duration", op: "nope", threshold: 1, action: "drop" }])
        ).toThrow("Unknown op");
    });

    test("throws on invalid action", () => {
        expect(() =>
            compileRules([{ column: "duration", op: "lt", threshold: 1, action: "yeet" }])
        ).toThrow("Unknown action");
    });
});

describe("parseConfig", () => {
    test("returns empty config for missing file", () => {
        const config = parseConfig("/tmp/nonexistent.toml");
        expect(config.filters).toBeUndefined();
    });
});
