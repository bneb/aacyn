/**
 * SLO API Routes
 *
 * GET  /v1/slo          — list all SLOs and current status
 * GET  /v1/slo/:service — SLO details for a specific service
 */

import { Elysia } from "elysia";
import { withStore } from "../lib/store-init";
import { SloEngine } from "../lib/slo";

export const sloRoutes = new Elysia()
    .use(withStore)
    .get("/v1/slo", () => {
        return { slos: sloEngine.all() };
    })
    .get("/v1/slo/:service", ({ params: { service } }) => {
        const states = sloEngine.all().filter(s => s.definition.service === service || s.definition.service === "*");
        if (states.length === 0) {
            return { error: `No SLOs defined for service: ${service}` };
        }
        const serviceName = service.replace(/-/g, " ");
        const burnAlerts = sloEngine.checkBurnAlerts().filter(a => a.slo.service === service || a.slo.service === "*");
        return {
            service,
            displayName: serviceName,
            slos: states,
            burnAlerts: burnAlerts.map(a => ({
                slo: a.slo.name,
                alert: a.alert,
                burnRate1h: a.state.burnRate1h,
                burnRate6h: a.state.burnRate6h,
                budgetRemaining: Math.round(a.state.budgetRemaining * 10000) / 100,
            })),
        };
    });

/** Global SLO engine instance — initialized once, shared across routes and alerting. */
export const sloEngine = new SloEngine();
