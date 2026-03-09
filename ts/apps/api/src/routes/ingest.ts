/**
 * Batch Ingestion Route — POST /ingest/batch
 *
 * Accepts a batch of RED metric events and writes them to the
 * native columnar store (mmap'd SoA via bun:ffi).
 *
 * Falls back to the V8 Map store if libaacyn is not compiled.
 *
 * Wire format:
 *   { events: [{ traceId, service, durationMs, isError, timestamp }] }
 */

import { Elysia, t } from "elysia";
import { withStore } from "../lib/store-init";
import { createLogger } from "../lib/logger";
const log = createLogger("routes-ingest");





// ─── Forwarder integration (lazy-loaded to avoid circular deps) ──────────
async function forwardBatch(events: { service: string; durationMs: number; isError: boolean; timestamp: number }[]): Promise<void> {
    try {
        const { forwarders } = await import("../lib/forwarder");
        if (forwarders.enabled.length === 0) return;

        const now = Math.floor(Date.now() / 1000);
        const batch = {
            metrics: events.map(e => ({
                service: e.service,
                rate: 1,
                errorRate: e.isError ? 100 : 0,
                p50Ms: e.durationMs,
                p95Ms: e.durationMs,
                p99Ms: e.durationMs,
                throughputKbps: 0,
                timestamp: now,
            })),
            edges: [] as { source: string; target: string; hitCount: number; avgLatencyUs: number; errorCount: number; totalBytes: number; timestamp: number }[],
        };

        forwarders.forwardToAll(batch).catch(err =>
            log.error("[Forwarder] Background send failed: " + (err as Error).message)
        );
    } catch (err) {
        // Forwarder module not available — skip (non-critical path)
        if ((err as Error).message !== "Cannot find module") {
            log.warn("[Forwarder] Forwarding unavailable: " + (err as Error).message);
        }
    }
}

// ─── JSON Ingestion ──────────────────────────────────────────────────────

export const ingestRoutes = new Elysia()
    .use(withStore)
    .post(
        "/ingest/batch",
        ({ body, set, store }) => {
            const { events } = body;
            const accepted = store.ingestBatch(events);

            // Fire-and-forget: forward to configured upstreams (Datadog, etc.)
            forwardBatch(events);

            set.status = 202;
            return {
                accepted,
                timestamp: Date.now(),
            };
        },
        {
            body: t.Object({
                events: t.Array(
                    t.Object({
                        traceId: t.String(),
                        service: t.String(),
                        durationMs: t.Number(),
                        isError: t.Boolean(),
                        timestamp: t.Number(),
                    })
                ),
            }),
        }
    )

    // ─── Binary Ingestion (zero-parse FlatBuffer) ───────────────────────────────
    //
    // POST /ingest/binary
    // Content-Type: application/octet-stream
    // Body: raw FlatBuffer binary payload (TelemetryBatch)
    //
    // Hot path: Request → ArrayBuffer → bun:ffi ptr → C memcpy → mmap SoA
    // Zero JSON parsing. Zero TypeBox validation. Zero V8 GC pressure.

    .post(
        "/ingest/binary",
        async ({ request, set, store }) => {
            // Extract raw ArrayBuffer — NO parsing
            const buffer = await request.arrayBuffer();
            if (buffer.byteLength < 8) {
                set.status = 400;
                return { error: `Binary payload too small: ${buffer.byteLength} bytes. Minimum is 8 bytes (FlatBuffer header). Ensure you are sending a valid TelemetryBatch FlatBuffer binary.`, timestamp: Date.now() };
            }

            // Pass pointer directly to C — ZERO COPY
            let accepted: number;
            try {
                accepted = store.ingestBinary(buffer);
            } catch (err) {
                if ((err as Error).name === "UnsupportedError") {
                    set.status = 501;
                    return { error: "Binary ingestion requires the native FFI store (libaacyn.so). The V8 Map store does not support binary ingest.", timestamp: Date.now() };
                }
                set.status = 500;
                return { error: "Internal error during binary ingestion: " + (err as Error).message, timestamp: Date.now() };
            }

            set.status = 202;
            return {
                accepted,
                timestamp: Date.now(),
                mode: "binary",
            };
        }
    );
