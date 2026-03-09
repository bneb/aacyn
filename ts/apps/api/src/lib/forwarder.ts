import { createLogger } from "./logger";
const log = createLogger("lib-forwarder");

/**
 * Upstream Forwarder Abstraction
 *
 * Pluggable forwarder interface for shipping pre-aggregated telemetry to
 * external observability platforms. Implementations exist for Datadog
 * (Metrics API v2) and Splunk (HTTP Event Collector).
 *
 * Configured via environment variables:
 *   DATADOG_API_KEY, DATADOG_SITE → DatadogForwarder
 *   SPLUNK_HEC_URL, SPLUNK_HEC_TOKEN → SplunkForwarder
 */

export interface ForwarderConfig {
    /** Unique forwarder name (e.g., "datadog", "splunk") */
    name: string;
    /** Whether this forwarder is enabled */
    enabled: boolean;
    /** Arbitrary config keys from aacyn.toml */
    [key: string]: unknown;
}

export interface ForwardBatch {
    /** RED metrics to forward (pre-aggregated per service) */
    metrics: {
        service: string;
        rate: number;
        errorRate: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        throughputKbps: number;
        timestamp: number;
    }[];
    /** Topology edges (connection events) */
    edges: {
        source: string;
        target: string;
        hitCount: number;
        avgLatencyUs: number;
        errorCount: number;
        totalBytes: number;
        timestamp: number;
    }[];
}

export interface Forwarder {
    /** Human-readable name */
    readonly name: string;
    /** Send a batch of pre-aggregated telemetry to the target platform */
    send(batch: ForwardBatch): Promise<{ accepted: number; rejected: number }>;
    /** Health check — returns true if the target is reachable */
    healthCheck(): Promise<boolean>;
    /** Graceful shutdown — flush any pending buffers */
    shutdown(): Promise<void>;
}

/**
 * Forwarder registry. Holds all configured forwarder instances.
 * Routes iterate over enabled forwarders after local ingestion.
 */
export class ForwarderRegistry {
    private forwarders: Forwarder[] = [];

    register(forwarder: Forwarder): void {
        this.forwarders.push(forwarder);
    }

    get enabled(): Forwarder[] {
        return this.forwarders;
    }

    /** Send a batch to all enabled forwarders. Survives individual failures. */
    async forwardToAll(batch: ForwardBatch): Promise<{ [name: string]: { accepted: number; rejected: number } }> {
        const results: { [name: string]: { accepted: number; rejected: number } } = {};

        await Promise.all(
            this.forwarders.map(async (fwd) => {
                try {
                    results[fwd.name] = await fwd.send(batch);
                } catch (err) {
                    log.error(
                        `[Forwarder] ${fwd.name} failed: ${(err as Error).message}`
                    );
                    results[fwd.name] = { accepted: 0, rejected: batch.metrics.length + batch.edges.length };
                }
            })
        );

        return results;
    }

    /** Shutdown all forwarders gracefully. */
    async shutdownAll(): Promise<void> {
        await Promise.all(
            this.forwarders.map((fwd) =>
                fwd.shutdown().catch((err) =>
                    log.error(`[Forwarder] ${fwd.name} shutdown error:`, err)
                )
            )
        );
    }
}

/** Global forwarder registry. */
export const forwarders = new ForwarderRegistry();
