import type { AlertState, AlertRule } from "./alerting";
import { createLogger } from "./logger";

const log = createLogger("lib-slack-webhook");

/** Sends Slack-formatted alert messages to a Slack webhook URL. */
export class SlackWebhookAlertOutput {
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
