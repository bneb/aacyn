/**
 * Prometheus-Compatible Metrics Exposition
 *
 * Lightweight in-memory metrics registry. No external dependencies —
 * we dogfood our own columnar store principles. Exposes counters,
 * histograms, and gauges in Prometheus text format at GET /v1/metrics.
 *
 * Usage:
 *   import { metrics } from "./lib/metrics";
 *   metrics.count("ingest_events_total", eventCount, { format: "json" });
 *   metrics.duration("query_duration_ms", ms, { endpoint: "/v1/query" });
 */

interface MetricLabel {
    name: string;
    value: string;
}

interface Counter {
    name: string;
    help: string;
    type: "counter";
    labels: MetricLabel[];
    value: number;
}

interface HistogramBucket {
    le: string; // "0.005", "0.01", "0.025", ...
    count: number;
}

interface Histogram {
    name: string;
    help: string;
    type: "histogram";
    labels: MetricLabel[];
    buckets: HistogramBucket[];
    sum: number;
    count: number;
}

interface Gauge {
    name: string;
    help: string;
    type: "gauge";
    labels: MetricLabel[];
    value: number;
}

type Metric = Counter | Histogram | Gauge;

const DEFAULT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class MetricsRegistry {
    private metrics = new Map<string, Metric>();

    /** Increment a counter. Creates it if it doesn't exist. */
    count(name: string, inc: number = 1, labels: Record<string, string> = {}, help: string = ""): void {
        const key = this.metricKey(name, labels);
        let metric = this.metrics.get(key) as Counter | undefined;
        if (!metric) {
            metric = {
                name,
                help,
                type: "counter",
                labels: this.toLabels(labels),
                value: 0,
            };
            this.metrics.set(key, metric);
        }
        metric.value += inc;
    }

    /** Record a duration observation in a histogram. Creates it if it doesn't exist. */
    duration(name: string, valueMs: number, labels: Record<string, string> = {}, help: string = ""): void {
        const key = this.metricKey(name, labels);
        let metric = this.metrics.get(key) as Histogram | undefined;
        if (!metric) {
            metric = {
                name,
                help,
                type: "histogram",
                labels: this.toLabels(labels),
                buckets: DEFAULT_BUCKETS.map(le => ({ le: le.toString(), count: 0 })),
                sum: 0,
                count: 0,
            };
            this.metrics.set(key, metric);
        }

        metric.sum += valueMs;
        metric.count++;

        for (const bucket of metric.buckets) {
            if (valueMs <= parseFloat(bucket.le)) {
                bucket.count++;
            }
        }
    }

    /** Set a gauge value. Creates it if it doesn't exist. */
    gauge(name: string, value: number, labels: Record<string, string> = {}, help: string = ""): void {
        const key = this.metricKey(name, labels);
        let metric = this.metrics.get(key) as Gauge | undefined;
        if (!metric) {
            metric = {
                name,
                help,
                type: "gauge",
                labels: this.toLabels(labels),
                value: 0,
            };
            this.metrics.set(key, metric);
        }
        metric.value = value;
    }

    /** Generate Prometheus text format output. */
    prometheusText(): string {
        const lines: string[] = [];

        for (const metric of this.metrics.values()) {
            // HELP + TYPE
            if (metric.help) {
                lines.push(`# HELP ${metric.name} ${metric.help}`);
            }
            lines.push(`# TYPE ${metric.name} ${metric.type}`);

            const labelStr = this.formatLabels(metric.labels);

            if (metric.type === "counter" || metric.type === "gauge") {
                lines.push(`${metric.name}${labelStr} ${metric.value}`);
            } else if (metric.type === "histogram") {
                const h = metric as Histogram;
                for (const bucket of h.buckets) {
                    lines.push(`${metric.name}_bucket${labelStr}{le="${bucket.le}"} ${bucket.count}`);
                }
                lines.push(`${metric.name}_bucket${labelStr}{le="+Inf"} ${h.count}`);
                lines.push(`${metric.name}_sum${labelStr} ${h.sum}`);
                lines.push(`${metric.name}_count${labelStr} ${h.count}`);
            }
        }

        return lines.join("\n") + "\n";
    }

    /** Reset all metrics (for testing). */
    reset(): void {
        this.metrics.clear();
    }

    /** Number of registered metric series. */
    get size(): number {
        return this.metrics.size;
    }

    private metricKey(name: string, labels: Record<string, string>): string {
        return name + ":" + Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",");
    }

    private toLabels(obj: Record<string, string>): MetricLabel[] {
        return Object.entries(obj).map(([name, value]) => ({ name, value }));
    }

    private formatLabels(labels: MetricLabel[]): string {
        if (labels.length === 0) return "";
        return "{" + labels.map(l => `${l.name}="${l.value}"`).join(",") + "}";
    }
}

/** Singleton metrics registry for the process. */
export const metrics = new MetricsRegistry();
