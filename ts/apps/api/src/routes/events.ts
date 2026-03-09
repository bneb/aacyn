import { Elysia, t } from "elysia";
import type { TelemetryEvent } from "@aacyn/sdk";
import { withStore } from "../lib/store-init";
import { createLogger } from "../lib/logger";
const log = createLogger("routes-events");

export const eventsRoutes = new Elysia()
    .use(withStore)
    .post(
        "/v1/events",
        async ({ body, store }) => {
            const events = body as TelemetryEvent[];

            // Forward to ingest pipeline — events are stored in the columnar store
            // and made available for query, forwarding, and alerting.
            store.ingestBatch(
                events.map(e => ({
                    traceId: e.id,
                    service: e.service,
                    durationMs: e.metric?.value ?? 0,
                    isError: false,
                    timestamp: e.timestamp,
                }))
            );
            log.info(`📥 Ingested ${events.length} events`);

            return {
                accepted: events.length,
                timestamp: Date.now(),
            };
        },
        {
            body: t.Array(
                t.Object({
                    id: t.String(),
                    timestamp: t.Number(),
                    kind: t.Union([t.Literal("metric"), t.Literal("trace"), t.Literal("log")]),
                    service: t.String(),
                    host: t.String(),
                    tags: t.Record(t.String(), t.String()),
                })
            ),
        }
    );
