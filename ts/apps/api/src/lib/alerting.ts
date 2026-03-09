/**
 * Alerting Engine — Threshold-Based Alerts on Golden Signals
 *
 * Monitors the topology endpoint for RED metrics and fires alerts
 * when user-defined thresholds are breached. The state machine:
 *
 *   OK ---> FIRING  (threshold breached for N consecutive evaluations)
 *   FIRING ---> OK  (threshold cleared for M consecutive evaluations)
 *   FIRING ---> RESOLVED (auto-resolve after threshold clears)
 *
 * Outputs: Slack webhook, generic webhook, stdout
 *
 * Configured via aacyn.toml [alert] sections.
 *
 * Usage:
 *   import { AlertEngine } from "./lib/alerting";
 *   const engine = new AlertEngine(config);
 *   engine.start(topologyProvider, 30_000); // evaluate every 30s
 */

import { metrics } from "./metrics";
import { createLogger } from "./logger";
const log = createLogger("lib-alerting");



// --- Types ------------------------------------------------------------------

export interface AlertRule {
    /** Unique rule identifier */
    name: string;
    /** Human-readable description for alert messages */
    description: string;
    /** Rule category that determines evaluation behavior */
    type: "threshold" | "rate_drop" | "new_service" | "service_disappeared";
    /** What metric to watch (for threshold rules) */
    metric?: "error_pct" | "rate_rps" | "avg_latency_ms" | "throughput_kbps" | "ebpf_drops";
    /** Comparison operator (for threshold rules) */
    operator?: "gt" | "lt" | "gte" | "lte";
    /** Threshold value (for threshold rules) */
    threshold?: number;
    /** How many consecutive evaluations must breach before firing */
    firingsBeforeAlert: number;
    /** How many consecutive clear evaluations before resolving */
    clearsBeforeResolve: number;
    /** Optional: only watch services matching this pattern (glob) */
    servicePattern?: string;
    /** Optional: minimum evaluation interval override (ms) */
    evaluationIntervalMs?: number;
    /** Severity label */
    severity: "critical" | "warning" | "info";
}

export interface AlertState {
    ruleName: string;
    status: "ok" | "firing" | "resolved";
    currentValue: number;
    threshold: number;
    operator: string;
    service?: string;
    firingSince?: number;
    resolvedAt?: number;
    consecutiveBreaches: number;
    consecutiveClears: number;
    lastEvaluation: number;
}

export interface AlertOutput {
    /** Output name for logging */
    readonly name: string;
    /** Send an alert notification */
    fire(alert: AlertState, rule: AlertRule): Promise<void>;
    /** Send a resolution notification */
    resolve(alert: AlertState, rule: AlertRule): Promise<void>;
}

export interface AlertEngineConfig {
    rules: AlertRule[];
    outputs: AlertOutput[];
}



// --- Built-in Outputs -------------------------------------------------------

/** Writes one-line formatted alerts to stdout. Always enabled. */
export class StdoutAlertOutput implements AlertOutput {
    readonly name = "stdout";

    async fire(alert: AlertState, rule: AlertRule): Promise<void> {
        const parts = [
            `[ALERT] ${rule.severity.toUpperCase()} ${rule.name}`,
            rule.metric && `metric=${alert.currentValue}`,
            rule.operator && rule.threshold !== undefined && `threshold=${rule.operator} ${rule.threshold}`,
            alert.service && `service=${alert.service}`,
            `at ${new Date().toISOString()}`,
        ].filter(Boolean).join(" ");
        process.stdout.write(parts + "\n");
    }

    async resolve(alert: AlertState, rule: AlertRule): Promise<void> {
        const svc = alert.service ? ` service=${alert.service}` : "";
        process.stdout.write(`[RESOLVED] ${rule.name}${svc} at ${new Date().toISOString()}\n`);
    }
}

/** Sends alerts to a generic webhook URL (Slack-compatible JSON payload). */
export class WebhookAlertOutput implements AlertOutput {
    readonly name = "webhook";
    private url: string;

    constructor(url: string) {
        this.url = url;
    }

    async fire(alert: AlertState, rule: AlertRule): Promise<void> {
        const color = rule.severity === "critical" ? "#dc2626" :
                      rule.severity === "warning"  ? "#f59e0b" : "#3b82f6";

        const payload = {
            attachments: [{
                color,
                title: `\u{1F6A8} ${rule.severity.toUpperCase()}: ${rule.name}`,
                text: rule.description,
                fields: [
                    { title: "Service", value: alert.service || "global", short: true },
                    { title: "Metric", value: `${rule.metric} = ${alert.currentValue} (threshold: ${rule.operator} ${rule.threshold})`, short: true },
                    { title: "Firing since", value: alert.firingSince ? new Date(alert.firingSince).toISOString() : "just now", short: false },
                ],
                footer: "aacyn alerting",
                ts: Math.floor(Date.now() / 1000),
            }],
        };

        try {
            const res = await fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
                log.error(`[Alerting] Webhook failed: ${res.status} ${await res.text()}`);
            }
        } catch (err) {
            log.error(`[Alerting] Webhook unreachable: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async resolve(alert: AlertState, rule: AlertRule): Promise<void> {
        const payload = {
            attachments: [{
                color: "#22c55e",
                title: `✅ RESOLVED: ${rule.name}`,
                text: rule.description,
                fields: [
                    { title: "Service", value: alert.service || "global", short: true },
                    { title: "Current value", value: `${rule.metric} = ${alert.currentValue}`, short: true },
                    { title: "Resolved at", value: new Date().toISOString(), short: false },
                ],
                footer: "aacyn alerting",
                ts: Math.floor(Date.now() / 1000),
            }],
        };

        try {
            await fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(5_000),
            });
        } catch (err) {
            log.error(`[Alerting] Webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/** Sends Slack-formatted alert messages to a Slack webhook URL. */
export class SlackWebhookAlertOutput implements AlertOutput {
    readonly name = "slack-webhook";
    private url: string;

    constructor(url: string) {
        this.url = url;
    }

    async fire(alert: AlertState, rule: AlertRule): Promise<void> {
        const emoji = rule.severity === "critical" ? ":fire:" :
                      rule.severity === "warning"  ? ":warning:" : ":information_source:";

        let text = `${emoji} *${rule.severity.toUpperCase()}: ${rule.name}*\n> ${rule.description}\n> Service: ${alert.service || "global"}`;
        if (rule.metric && rule.operator && rule.threshold !== undefined) {
            text += `\n> ${rule.metric} = ${alert.currentValue} (threshold: ${rule.operator} ${rule.threshold})`;
        }
        text += `\n> Timestamp: ${new Date().toISOString()}`;

        try {
            const res = await fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
                log.error(`[Slack] Webhook failed: ${res.status} ${await res.text()}`);
            }
        } catch (err) {
            log.error(`[Slack] Webhook unreachable: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async resolve(alert: AlertState, rule: AlertRule): Promise<void> {
        const text = [
            `:white_check_mark: *RESOLVED: ${rule.name}*`,
            `> Service: ${alert.service || "global"}`,
            `> Timestamp: ${new Date().toISOString()}`,
        ].join("\n");

        try {
            await fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(5_000),
            });
        } catch (err) {
            log.error(`[Slack] Webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}



// --- Topology Provider Type -------------------------------------------------

export interface TopologySnapshot {
    edges: {
        target: string;
        hit_count: number;
        latency_us: number;
        bytes_transferred: number;
        error_count: number;
    }[];
    golden_signals: {
        service: string;
        rate_rps: number;
        error_pct: number;
        avg_latency_ms: number;
        throughput_kbps: number;
    }[];
    drops: { standard: number; critical: number };
}



// --- Alert Engine -----------------------------------------------------------

export class AlertEngine {
    private rules: AlertRule[];
    private outputs: AlertOutput[];
    private states = new Map<string, AlertState>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private prevRates = new Map<string, number>();
    private seenServices = new Set<string>();
    private lastSeenTimes = new Map<string, number>();

    constructor(config: AlertEngineConfig) {
        this.rules = config.rules;
        this.outputs = config.outputs;
        this.initializeStates();
    }

    /** Start periodic evaluation. topologyProvider should return current metrics. */
    start(
        topologyProvider: () => TopologySnapshot | null,
        intervalMs: number = 30_000
    ): void {
        if (this.timer) return;

        log.info(
            `[Alerting] Engine started — ${this.rules.length} rules, ` +
            `${this.outputs.map(o => o.name).join(", ")} outputs, ` +
            `evaluating every ${intervalMs / 1000}s`
        );

        const evaluate = () => {
            const snapshot = topologyProvider();
            if (!snapshot) return;
            this.evaluate(snapshot);
        };

        evaluate(); // First evaluation immediately
        this.timer = setInterval(evaluate, intervalMs);
    }

    /** Stop periodic evaluation. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            log.info("[Alerting] Engine stopped");
        }
    }

    /** Get current state of all alert rules. */
    getStates(): AlertState[] {
        return Array.from(this.states.values());
    }

    /**
     * Evaluate all rules against a topology snapshot.
     * Called on each evaluation cycle.
     */
    private evaluate(snapshot: TopologySnapshot): void {
        const currentServices = new Set(snapshot.golden_signals.map(s => s.service));

        for (const rule of this.rules) {
            if (rule.type === "threshold") {
                this.evaluateThreshold(rule, snapshot);
            } else if (rule.type === "rate_drop") {
                this.evaluateRateDrop(rule, snapshot);
            } else if (rule.type === "new_service") {
                this.evaluateNewService(rule, snapshot, currentServices);
            } else if (rule.type === "service_disappeared") {
                this.evaluateServiceDisappeared(rule, snapshot, currentServices);
            }
        }

        this.trackServices(snapshot, currentServices);
    }

    /** Evaluate a threshold rule against golden signals. */
    private evaluateThreshold(rule: AlertRule, snapshot: TopologySnapshot): void {
        if (rule.servicePattern) {
            const matchingServices = snapshot.golden_signals
                .filter(s => this.matchesPattern(s.service, rule.servicePattern!));

            for (const svc of matchingServices) {
                const value = this.extractMetric(rule.metric!, svc, snapshot.drops);
                this.evaluateRule(rule, `${rule.name}:${svc.service}`, value, svc.service);
            }

            if (matchingServices.length === 0 && this.isGlobalMetric(rule.metric!)) {
                this.evaluateRule(rule, rule.name, this.extractGlobalMetric(rule.metric!, snapshot));
            }
        } else {
            const value = this.isGlobalMetric(rule.metric!)
                ? this.extractGlobalMetric(rule.metric!, snapshot)
                : this.extractWorstServiceMetric(rule.metric!, snapshot.golden_signals);
            this.evaluateRule(rule, rule.name, value);
        }
    }

    /** Evaluate whether any service's request rate dropped > 50%. */
    private evaluateRateDrop(rule: AlertRule, snapshot: TopologySnapshot): void {
        for (const svc of snapshot.golden_signals) {
            const prev = this.prevRates.get(svc.service);
            if (prev === undefined || prev <= 0) {
                this.prevRates.set(svc.service, svc.rate_rps);
                continue;
            }
            const dropPct = ((prev - svc.rate_rps) / prev) * 100;
            this.evaluateRule(rule, `${rule.name}:${svc.service}`, dropPct, svc.service);
            this.prevRates.set(svc.service, svc.rate_rps);
        }
    }

    /** Detect new services appearing in the topology for the first time. */
    private evaluateNewService(rule: AlertRule, snapshot: TopologySnapshot, _currentServices: Set<string>): void {
        const now = Date.now();
        for (const svc of snapshot.golden_signals) {
            if (this.seenServices.has(svc.service)) continue;
            this.seenServices.add(svc.service);
            const state = this.getOrCreateAlertState(`${rule.name}:${svc.service}`, rule, svc.service);
            state.currentValue = 1;
            state.lastEvaluation = now;
            state.status = "firing";
            state.firingSince = now;
            this.notifyFire(state, rule);
            metrics.count("aacyn_alerts_firing_total", 1, { rule: rule.name, severity: rule.severity });
            state.status = "ok";
            state.resolvedAt = now;
            state.firingSince = undefined;
        }
    }

    /** Fire when a known service hasn"t been seen for 5+ minutes. */
    private evaluateServiceDisappeared(
        rule: AlertRule,
        snapshot: TopologySnapshot,
        currentServices: Set<string>,
    ): void {
        const now = Date.now();
        const fiveMinMs = 300_000;

        for (const [svcName, lastSeen] of this.lastSeenTimes) {
            if (currentServices.has(svcName)) {
                const stateKey = `${rule.name}:${svcName}`;
                const state = this.states.get(stateKey);
                if (state && state.status === "firing") {
                    state.currentValue = 0;
                    this.transitionToResolved(state, rule);
                }
                continue;
            }
            if ((now - lastSeen) < fiveMinMs) continue;

            const stateKey = `${rule.name}:${svcName}`;
            const state = this.getOrCreateAlertState(stateKey, rule, svcName);
            if (state.status === "firing") continue;
            state.currentValue = 1;
            state.lastEvaluation = now;
            this.updateBreachCounters(state, true);
            if (state.status === "ok" && state.consecutiveBreaches >= rule.firingsBeforeAlert) {
                this.transitionToFiring(state, rule);
            }
        }
    }

    /** Update per-service tracking state after each evaluation cycle. */
    private trackServices(snapshot: TopologySnapshot, currentServices: Set<string>): void {
        const now = Date.now();
        for (const svc of snapshot.golden_signals) {
            this.seenServices.add(svc.service);
            this.lastSeenTimes.set(svc.service, now);
            this.prevRates.set(svc.service, svc.rate_rps);
        }
    }

    private evaluateRule(
        rule: AlertRule,
        stateKey: string,
        currentValue: number,
        service?: string
    ): void {
        const state = this.getOrCreateAlertState(stateKey, rule, service);
        state.currentValue = currentValue;
        state.lastEvaluation = Date.now();

        const breached = this.checkThreshold(currentValue, rule.operator ?? "gt", rule.threshold ?? 0);
        this.updateBreachCounters(state, breached);

        if (state.status === "ok" && state.consecutiveBreaches >= rule.firingsBeforeAlert) {
            this.transitionToFiring(state, rule);
        } else if (state.status === "firing" && state.consecutiveClears >= rule.clearsBeforeResolve) {
            this.transitionToResolved(state, rule);
        }
    }

    private getOrCreateAlertState(stateKey: string, rule: AlertRule, service?: string): AlertState {
        let state = this.states.get(stateKey);
        if (!state) {
            state = {
                ruleName: rule.name,
                status: "ok",
                currentValue: 0,
                threshold: rule.threshold ?? 0,
                operator: rule.operator ?? "gt",
                service,
                consecutiveBreaches: 0,
                consecutiveClears: 0,
                lastEvaluation: Date.now(),
            };
            this.states.set(stateKey, state);
        }
        return state;
    }

    private updateBreachCounters(state: AlertState, breached: boolean): void {
        if (breached) {
            state.consecutiveBreaches++;
            state.consecutiveClears = 0;
        } else {
            state.consecutiveClears++;
            state.consecutiveBreaches = 0;
        }
    }

    private transitionToFiring(state: AlertState, rule: AlertRule): void {
        state.status = "firing";
        state.firingSince = Date.now();
        this.notifyFire(state, rule);
        metrics.count("aacyn_alerts_firing_total", 1, {
            rule: rule.name,
            severity: rule.severity,
        });
    }

    private transitionToResolved(state: AlertState, rule: AlertRule): void {
        state.status = "ok";
        state.resolvedAt = Date.now();
        state.firingSince = undefined;
        this.notifyResolve(state, rule);
        metrics.count("aacyn_alerts_resolved_total", 1, {
            rule: rule.name,
        });
    }

    private checkThreshold(value: number, op: AlertRule["operator"], threshold: number): boolean {
        switch (op) {
            case "gt":  return value > threshold;
            case "gte": return value >= threshold;
            case "lt":  return value < threshold;
            case "lte": return value <= threshold;
            default: return false;
        }
    }

    private extractMetric(
        metric: AlertRule["metric"],
        signal: TopologySnapshot["golden_signals"][0],
        drops: TopologySnapshot["drops"]
    ): number {
        switch (metric) {
            case "error_pct":       return signal.error_pct;
            case "rate_rps":        return signal.rate_rps;
            case "avg_latency_ms":  return signal.avg_latency_ms;
            case "throughput_kbps": return signal.throughput_kbps;
            case "ebpf_drops":      return drops.standard + drops.critical;
            default:                return 0;
        }
    }

    private extractGlobalMetric(
        metric: AlertRule["metric"],
        snapshot: TopologySnapshot
    ): number {
        switch (metric) {
            case "ebpf_drops":
                return snapshot.drops.standard + snapshot.drops.critical;
            case "error_pct":
                return snapshot.golden_signals.length > 0
                    ? Math.max(...snapshot.golden_signals.map(s => s.error_pct))
                    : 0;
            case "avg_latency_ms":
                return snapshot.golden_signals.length > 0
                    ? Math.max(...snapshot.golden_signals.map(s => s.avg_latency_ms))
                    : 0;
            default:
                return 0;
        }
    }

    private extractWorstServiceMetric(
        metric: AlertRule["metric"],
        signals: TopologySnapshot["golden_signals"]
    ): number {
        if (signals.length === 0) return 0;
        switch (metric) {
            case "error_pct":       return Math.max(...signals.map(s => s.error_pct));
            case "rate_rps":        return Math.max(...signals.map(s => s.rate_rps));
            case "avg_latency_ms":  return Math.max(...signals.map(s => s.avg_latency_ms));
            case "throughput_kbps": return Math.max(...signals.map(s => s.throughput_kbps));
            case "ebpf_drops":      return 0;
            default:                return 0;
        }
    }

    private isGlobalMetric(metric: AlertRule["metric"]): boolean {
        return metric === "ebpf_drops";
    }

    private matchesPattern(value: string, pattern: string): boolean {
        if (!pattern) return true;
        const regex = new RegExp(
            "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
            "i"
        );
        return regex.test(value);
    }

    private async notifyFire(state: AlertState, rule: AlertRule): Promise<void> {
        const msg = `ALERT ${rule.severity.toUpperCase()}: ${rule.name} — ${rule.metric}=${state.currentValue} (threshold: ${rule.operator} ${rule.threshold})${state.service ? ` on ${state.service}` : ""}`;
        log.error(`[\u{1F6A8} Alerting] ${msg}`);

        for (const output of this.outputs) {
            try {
                await output.fire(state, rule);
            } catch (err) {
                log.error(`[Alerting] Output ${output.name} failed: ` + (err instanceof Error ? err.message : String(err)));
            }
        }
    }

    private async notifyResolve(state: AlertState, rule: AlertRule): Promise<void> {
        log.info(`[✅ Alerting] RESOLVED: ${rule.name}${state.service ? ` on ${state.service}` : ""}`);

        for (const output of this.outputs) {
            try {
                await output.resolve(state, rule);
            } catch (err) {
                log.error(`[Alerting] Output ${output.name} failed during resolve: ` + (err instanceof Error ? err.message : String(err)));
            }
        }
    }

    private initializeStates(): void {
        for (const rule of this.rules) {
            this.states.set(rule.name, {
                ruleName: rule.name,
                status: "ok",
                currentValue: 0,
                threshold: rule.threshold ?? 0,
                operator: rule.operator ?? "gt",
                consecutiveBreaches: 0,
                consecutiveClears: 0,
                lastEvaluation: 0,
            });
        }
    }
}



// --- Default Alert Rules ----------------------------------------------------

/** Sensible default alerts that ship with aacyn. Users customize in aacyn.toml. */
export const DEFAULT_ALERT_RULES: AlertRule[] = [
    { name: "high-error-rate",     description: "Service error rate exceeds 5% for 2 consecutive evaluations",     type: "threshold",            metric: "error_pct",  operator: "gt", threshold: 5.0, firingsBeforeAlert: 2, clearsBeforeResolve: 2, severity: "critical" },
    { name: "p99-latency-spike",   description: "P99 latency exceeds 500ms for any service",                      type: "threshold",            metric: "avg_latency_ms", operator: "gt", threshold: 500, firingsBeforeAlert: 1, clearsBeforeResolve: 2, severity: "warning" },
    { name: "throughput-drop",     description: "Request rate dropped more than 50% compared to previous evaluation", type: "rate_drop",      metric: "rate_rps", operator: "gt", threshold: 50, firingsBeforeAlert: 1, clearsBeforeResolve: 1, severity: "warning" },
    { name: "new-service-discovered", description: "A previously unseen service has been discovered in the topology", type: "new_service",    firingsBeforeAlert: 1, clearsBeforeResolve: 1, severity: "info" },
    { name: "service-disappeared", description: "A known service stopped sending data for more than 5 minutes",  type: "service_disappeared", firingsBeforeAlert: 1, clearsBeforeResolve: 1, severity: "warning" },
];
