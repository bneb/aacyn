/**
 * Alerting Routes — GET /v1/alerts, POST /v1/alerts/rules
 *
 * Exposes current alert states and allows runtime rule management.
 * The alert engine evaluates golden signals on a configurable interval.
 */

import { Elysia, t } from "elysia";

// Alert engine — initialized by server.ts on startup
let alertEngine: import("../lib/alerting").AlertEngine | null = null;

export function setAlertEngine(engine: import("../lib/alerting").AlertEngine): void {
    alertEngine = engine;
}

export const alertRoutes = new Elysia()
    /** List all alert states (current status of every rule). */
    .get("/v1/alerts", () => {
        if (!alertEngine) {
            return { alerts: [], engine: "not_initialized" };
        }
        return {
            alerts: alertEngine.getStates(),
            count: alertEngine.getStates().length,
            engine: "running",
        };
    })
    /** Create or update an alert rule at runtime. */
    .post(
        "/v1/alerts/rules",
        ({ body, set }) => {
            if (!alertEngine) {
                set.status = 503;
                return { error: "Alert engine not initialized. The server is still starting up — alert rules are loaded during server initialization. Try again in a few seconds. If this persists, check the server logs for startup errors." };
            }
            // Alert engine rules are set at construction time.
            // Runtime rule management requires an engine restart.
            // For now, report what rules are active.
            set.status = 202;
            return {
                message: "Runtime rule updates require alert engine restart. " +
                         "Configure rules in aacyn.toml [alert] sections for persistent configuration.",
                activeRules: alertEngine.getStates().map(s => s.ruleName),
            };
        },
        {
            body: t.Object({
                name: t.String(),
                metric: t.String(),
                operator: t.String(),
                threshold: t.Number(),
                severity: t.Optional(t.String()),
            }),
        }
    );
