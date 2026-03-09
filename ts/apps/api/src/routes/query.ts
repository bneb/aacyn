/**
 * Query Route — POST /v1/query
 *
 * Receives a SQL-like query string from the Grafana plugin (or curl),
 * parses it with a minimal regex extractor, executes a native C scan
 * against the AVX-512 ring buffer via FFI, and returns structured JSON.
 *
 * Query format:
 *   SELECT duration FROM events WHERE is_error = 1
 *   SELECT * FROM events
 *   SELECT timestamp, duration FROM events WHERE duration > 100
 *
 * The parser is intentionally minimal. We extract:
 *   - Time bounds from the request body (startNs/endNs)
 *   - is_error flag from the WHERE clause
 *   - A limit from the request body (default 50000)
 *
 * Response format matches what the Grafana Go backend expects:
 *   { columns, rows, durationNs, totalRows }
 */

import { Elysia, t } from "elysia";
import type { QueryResponse } from "@aacyn/sdk";
import type { IStore } from "@aacyn/sdk";
import { withStore } from "../lib/store-init";
import { createLogger } from "../lib/logger";
const log = createLogger("routes-query");



// ─── Types ──────────────────────────────────────────────────────────────────────

interface ParsedQuery {
    errorOnly: boolean;
    columns: string[];
}

interface QueryEvent {
    timestamp: number;
    duration: number;
    isError: boolean;
}

interface QueryResult {
    rows: (number | null)[][];
    totalRows: number;
}

// ─── Minimal Query Parser ────────────────────────────────────────────────────

function parseSQL(sql: string): ParsedQuery {
    const normalized = sql.trim().replace(/\s+/g, " ");

    const errorOnly = /WHERE\s+is_error\s*=\s*1/i.test(normalized);

    const colMatch = normalized.match(/^SELECT\s+(.+?)\s+FROM/i);
    let columns = ["timestamp", "duration", "is_error"];
    if (colMatch) {
        const colStr = colMatch[1].trim();
        if (colStr !== "*") {
            columns = colStr.split(",").map((c) => c.trim().toLowerCase());
        }
    }

    return { errorOnly, columns };
}

// ─── Query Execution ──────────────────────────────────────────────────────────

function mapEventToRow(e: QueryEvent, columns: string[]): (number | null)[] {
    return columns.map((col) => {
        switch (col) {
            case "timestamp":
            case "time":
            case "ts":
                return e.timestamp;
            case "duration":
            case "duration_ms":
                return e.duration;
            case "is_error":
            case "error":
                return e.isError ? 1 : 0;
            default:
                return null;
        }
    });
}

function executeStoreQuery(
    store: IStore,
    parsed: ParsedQuery,
    timeRange?: { startNs: number; endNs: number },
    limit?: number,
): QueryResult {
    const queryOpts: {
        startNs?: number;
        endNs?: number;
        errorOnly?: boolean;
        limit?: number;
    } = {
        errorOnly: parsed.errorOnly,
        limit: limit ?? 50000,
    };

    if (timeRange) {
        queryOpts.startNs = timeRange.startNs;
        queryOpts.endNs = timeRange.endNs;
    }

    try {
        const events = store.query(queryOpts);
        const rows = events.map((e) => mapEventToRow(e, parsed.columns));
        return { rows, totalRows: events.length };
    } catch (e) {
        log.warn("[query] Native scan not available, returning empty");
        return { rows: [], totalRows: 0 };
    }
}

// ─── Route ───────────────────────────────────────────────────────────────────────

export const queryRoutes = new Elysia()
    .use(withStore)
    .post(
    "/v1/query",
    async ({ body, set, store }) => {
        const startTime = performance.now();
        const parsed = parseSQL(body.sql);
        const { rows, totalRows } = executeStoreQuery(store, parsed, body.timeRange, body.limit);

        const durationNs = Math.round((performance.now() - startTime) * 1_000_000);

        log.info(
            `🔍 Query: "${body.sql}" → ${totalRows} rows in ${(durationNs / 1000).toFixed(0)}μs`
        );

        return {
            columns: parsed.columns,
            rows,
            durationNs,
            totalRows,
        };
    },
    {
        body: t.Object({
            sql: t.String(),
            timeRange: t.Optional(
                t.Object({
                    startNs: t.Number(),
                    endNs: t.Number(),
                })
            ),
            limit: t.Optional(t.Number()),
        }),
    }
);
