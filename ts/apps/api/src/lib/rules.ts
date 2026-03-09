/**
 * Declarative Filter & Rollup Rule Compiler
 *
 * Reads aacyn.toml, parses filter rules, and compiles them into
 * a packed binary array of aacyn_rule_t C structs (16 bytes each)
 * for transmission over FFI.
 *
 * Rule struct layout (16 bytes, packed):
 *   column    (u8)  — 0=duration, 1=is_error, 2=timestamp
 *   op        (u8)  — 0=LT, 1=GT, 2=EQ, 3=NEQ, 4=LTE, 5=GTE
 *   action    (u8)  — 0=DROP, 1=KEEP
 *   _pad      (u8)
 *   threshold (f64) — comparison value
 *   _reserved (u32)
 *
 * TOML schema:
 *   [[filters]]
 *   column = "duration"
 *   op = "lt"
 *   threshold = 1.0
 *   action = "drop"
 */

import { readFileSync, existsSync } from "fs";
import TOML from "@iarna/toml";
import { createLogger } from "./logger";
const log = createLogger("lib-rules");



// ─── Constants (must match libaacyn.c) ───────────────────────────────────────

const RULE_SIZE = 16; // bytes per rule

const COLUMNS: Record<string, number> = {
    duration: 0,
    is_error: 1,
    timestamp: 2,
};

const OPS: Record<string, number> = {
    lt: 0,
    gt: 1,
    eq: 2,
    neq: 3,
    lte: 4,
    gte: 5,
    "<": 0,
    ">": 1,
    "==": 2,
    "!=": 3,
    "<=": 4,
    ">=": 5,
};

const ACTIONS: Record<string, number> = {
    drop: 0,
    keep: 1,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FilterRule {
    column: string;
    op: string;
    threshold: number;
    action: string;
}

export interface AacynConfig {
    filters?: FilterRule[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse aacyn.toml and return the config object.
 */
export function parseConfig(path: string): AacynConfig {
    if (!existsSync(path)) {
        log.info(`[rules] No config file at ${path} — no filter rules loaded`);
        return {};
    }

    const raw = readFileSync(path, "utf-8");
    const parsed = TOML.parse(raw);
    return parsed as unknown as AacynConfig;
}

// ─── Compiler ────────────────────────────────────────────────────────────────

/**
 * Compile an array of FilterRule objects into a packed Uint8Array
 * of aacyn_rule_t structs (16 bytes each).
 */
export function compileRules(rules: FilterRule[]): { buffer: Uint8Array; count: number } {
    const count = Math.min(rules.length, 64); // AACYN_MAX_RULES
    const buffer = new Uint8Array(count * RULE_SIZE);
    const view = new DataView(buffer.buffer);

    for (let i = 0; i < count; i++) {
        const rule = rules[i];
        const offset = i * RULE_SIZE;

        const col = COLUMNS[rule.column];
        const op = OPS[rule.op];
        const action = ACTIONS[rule.action];

        if (col === undefined) {
            throw new Error(`Unknown column: "${rule.column}". Valid: ${Object.keys(COLUMNS).join(", ")}`);
        }
        if (op === undefined) {
            throw new Error(`Unknown op: "${rule.op}". Valid: ${Object.keys(OPS).join(", ")}`);
        }
        if (action === undefined) {
            throw new Error(`Unknown action: "${rule.action}". Valid: ${Object.keys(ACTIONS).join(", ")}`);
        }

        view.setUint8(offset + 0, col);       // column
        view.setUint8(offset + 1, op);        // op
        view.setUint8(offset + 2, action);    // action
        view.setUint8(offset + 3, 0);         // pad
        view.setFloat64(offset + 4, rule.threshold, true); // threshold (LE)
        view.setUint32(offset + 12, 0, true); // reserved
    }

    return { buffer, count };
}

/**
 * Load rules from an aacyn.toml file and compile them.
 */
export function loadAndCompileRules(
    configPath: string
): { buffer: Uint8Array; count: number; rules: FilterRule[] } {
    const config = parseConfig(configPath);
    const rules = config.filters ?? [];

    if (rules.length === 0) {
        return { buffer: new Uint8Array(0), count: 0, rules: [] };
    }

    const compiled = compileRules(rules);

    log.info(
        `[rules] Compiled ${compiled.count} filter rules from ${configPath}:`
    );
    for (const r of rules) {
        log.info(`  → ${r.action.toUpperCase()} WHERE ${r.column} ${r.op} ${r.threshold}`);
    }

    return { ...compiled, rules };
}
