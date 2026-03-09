import styles from "./benchmarks.module.css";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Header } from "@/components/header";

const HERO_STATS = [
    { value: "5,089,364", label: "events/second", footnote: "1" },
    { value: "16ms", label: "p99 latency", footnote: "1" },
    { value: "0.00%", label: "error rate", footnote: "1" },
    { value: "1 node", label: "consumer hardware", footnote: "2" },
];

const INDUSTRY = [
    {
        name: "aacyn",
        throughput: "5,089,364 evt/sec",
        hardware: "1× mini PC (8C/16T)",
        source: "This benchmark",
        sourceUrl: "#methodology",
        highlight: true,
    },
    {
        name: "Datadog Agent",
        throughput: "~200,000 metrics/sec",
        hardware: "Cloud VM (4 vCPU)",
        source: "Datadog docs",
        sourceUrl: "https://docs.datadoghq.com/developers/dogstatsd/high_throughput/",
        highlight: false,
    },
    {
        name: "Datadog Obs. Pipelines",
        throughput: "~85,000 evt/sec",
        hardware: "Multi-pod K8s",
        source: "Datadog docs",
        sourceUrl: "https://docs.datadoghq.com/observability_pipelines/",
        highlight: false,
    },
    {
        name: "ClickHouse (logs)",
        throughput: "~130,000 rows/sec",
        hardware: "Single node (8C, 16GB)",
        source: "GreptimeDB benchmark, 2024",
        sourceUrl: "https://greptime.com/blogs/2024-08-22-log-engine-benchmark",
        highlight: false,
    },
    {
        name: "Vector",
        throughput: "~76 MiB/sec",
        hardware: "File-to-TCP pipeline",
        source: "vector.dev",
        sourceUrl: "https://vector.dev/",
        highlight: false,
    },
];

const COMPARISON = [
    { metric: "Events/sec", json: "314K", binary: "5.09M", gain: "16.2×" },
    { metric: "p95 Latency", json: "218.79ms", binary: "12.73ms", gain: "17.2×" },
    { metric: "p99 Latency", json: "—", binary: "16.12ms", gain: "—" },
    { metric: "Avg Latency", json: "88.70ms", binary: "7.77ms", gain: "11.4×" },
    { metric: "Error Rate", json: "0.00%", binary: "0.00%", gain: "—" },
];

const SCAN_RESULTS = [
    { op: "scan_duration_max", median: "286μs", p99: "402μs", rate: "17.5B events/sec" },
    { op: "scan_error_count", median: "35μs", p99: "60μs", rate: "141.6B events/sec" },
    { op: "scan_duration_filter", median: "298μs", p99: "415μs", rate: "16.8B events/sec" },
];

const LATENCY_BREAKDOWN = [
    { percentile: "avg", value: "7.77ms" },
    { percentile: "p90", value: "11.42ms" },
    { percentile: "p95", value: "12.73ms" },
    { percentile: "p99", value: "16.12ms" },
    { percentile: "max", value: "33.19ms" },
];

const HARDWARE = [
    { label: "Machine", value: "Minisforum UM890 Pro" },
    { label: "CPU", value: "AMD Ryzen 9 8945HS (8C/16T, Zen 4)" },
    { label: "RAM", value: "32GB DDR5-5600" },
    { label: "Storage", value: "1TB NVMe" },
    { label: "OS", value: "Ubuntu Server 24.04 (no GUI)" },
];

export default function BenchmarksPage() {
    return (
        <div className={styles.page}>
            <Header />
            {/* ── Hero ─────────────────────────────────────────────────────────── */}
            <header className={styles.hero}>
                <h1 className={styles.hero__title}>
                    <span className={styles.hero__number}>5,089,364</span>
                    <span className={styles.hero__unit}>events per second</span>
                </h1>
                <p className={styles.hero__subtitle}>
                    Single node. Consumer hardware. Zero errors.
                </p>
            </header>

            {/* ── Stat Cards ───────────────────────────────────────────────────── */}
            <section className={styles.stats}>
                {HERO_STATS.map((stat) => (
                    <div key={stat.label} className={styles.stat}>
                        <span className={styles.stat__value}>{stat.value}</span>
                        <span className={styles.stat__label}>{stat.label}</span>
                        <sup className={styles.stat__footnote}>{stat.footnote}</sup>
                    </div>
                ))}
            </section>

            {/* ── Industry Comparison ──────────────────────────────────────────── */}
            <section className={styles.section}>
                <h2 className={styles.section__title}>Industry comparison</h2>
                <p className={styles.section__desc}>
                    All competitor figures are from publicly documented benchmarks and
                    official documentation. See source links for each.
                </p>
                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Platform</th>
                                <th>Throughput</th>
                                <th>Hardware</th>
                                <th>Source</th>
                            </tr>
                        </thead>
                        <tbody>
                            {INDUSTRY.map((row) => (
                                <tr key={row.name} className={row.highlight ? styles.table__rowHighlight : undefined}>
                                    <td className={row.highlight ? styles.table__highlight : styles.table__metric}>
                                        {row.name}
                                    </td>
                                    <td className={row.highlight ? styles.table__highlight : undefined}>
                                        {row.throughput}
                                    </td>
                                    <td className={styles.table__dim}>{row.hardware}</td>
                                    <td>
                                        <a
                                            href={row.sourceUrl}
                                            className={styles.table__link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            {row.source} ↗
                                        </a>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className={styles.caveat}>
                    <strong>Apples-to-apples caveat:</strong> These are directionally valid but
                    not identical workloads. Datadog measures DogStatsD metric intake (smaller payloads).
                    ClickHouse measures row insertion via native protocol with full indexing.
                    Vector measures byte throughput for data routing. aacyn measures FlatBuffer binary
                    event ingestion into an in-memory columnar store via HTTP.{" "}
                    <a href="https://github.com/aacyn/aacyn/blob/main/BENCHMARKS.md#apples-to-apples-notes">
                        Full comparison notes →
                    </a>
                </p>
            </section>

            {/* ── Binary vs JSON ───────────────────────────────────────────────── */}
            <section className={styles.section}>
                <h2 className={styles.section__title}>Binary vs JSON ingestion</h2>
                <p className={styles.section__desc}>
                    Path B (FlatBuffers) bypasses JSON parsing entirely. The payload crosses the
                    FFI boundary as a raw pointer — zero deserialization, zero V8 GC pressure.
                </p>
                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Metric</th>
                                <th>JSON</th>
                                <th>Binary</th>
                                <th>Gain</th>
                            </tr>
                        </thead>
                        <tbody>
                            {COMPARISON.map((row) => (
                                <tr key={row.metric}>
                                    <td className={styles.table__metric}>{row.metric}</td>
                                    <td className={styles.table__dim}>{row.json}</td>
                                    <td className={styles.table__highlight}>{row.binary}</td>
                                    <td className={styles.table__gain}>{row.gain}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* ── AVX-512 Scan Performance ──────────────────────────────────────── */}
            <section className={styles.section}>
                <h2 className={styles.section__title}>AVX-512 scan performance</h2>
                <p className={styles.section__desc}>
                    5 million events queried in under half a millisecond. AVX-512 processes 16
                    floats per CPU cycle over page-aligned columnar memory — no indexes, no hash
                    lookups, no pointer chasing.
                </p>
                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th>Scan Operation</th>
                                <th>Median</th>
                                <th>p99</th>
                                <th>Effective Rate</th>
                            </tr>
                        </thead>
                        <tbody>
                            {SCAN_RESULTS.map((row) => (
                                <tr key={row.op}>
                                    <td className={styles.table__metric}><code>{row.op}</code></td>
                                    <td className={styles.table__highlight}>{row.median}</td>
                                    <td>{row.p99}</td>
                                    <td className={styles.table__dim}>{row.rate}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className={styles.caveat}>
                    All scans complete in <strong>&lt; 415μs p99</strong>. The error count scan
                    is particularly fast because <code>is_errors</code> is a <code>uint8_t[]</code>{" "}
                    column that fits entirely in L2 cache.
                </p>
            </section>

            {/* ── Latency Distribution ─────────────────────────────────────────── */}
            <section className={styles.section}>
                <h2 className={styles.section__title}>Latency distribution</h2>
                <p className={styles.section__desc}>
                    At 5 million events/second, every request from the 1st to the 99th percentile
                    completes in under 17 milliseconds.
                </p>
                <div className={styles.latencyBars}>
                    {LATENCY_BREAKDOWN.map((item) => {
                        const maxMs = 35;
                        const ms = parseFloat(item.value);
                        const pct = Math.min((ms / maxMs) * 100, 100);
                        return (
                            <div key={item.percentile} className={styles.latencyRow}>
                                <span className={styles.latencyRow__label}>{item.percentile}</span>
                                <div className={styles.latencyRow__track}>
                                    <div className={styles.latencyRow__bar} style={{ width: `${pct}%` }} />
                                </div>
                                <span className={styles.latencyRow__value}>{item.value}</span>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* ── Hardware ──────────────────────────────────────────────────────── */}
            <section className={styles.section}>
                <h2 className={styles.section__title}>Hardware</h2>
                <p className={styles.section__desc}>
                    No cloud cluster. No Kafka. One consumer-grade mini PC.
                </p>
                <div className={styles.hardwareGrid}>
                    {HARDWARE.map((item) => (
                        <div key={item.label} className={styles.hardwareItem}>
                            <span className={styles.hardwareItem__label}>{item.label}</span>
                            <span className={styles.hardwareItem__value}>{item.value}</span>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── Methodology ──────────────────────────────────────────────────── */}
            <section id="methodology" className={`${styles.section} ${styles.methodology}`}>
                <h2 className={styles.section__title}>Methodology</h2>
                <p className={styles.methodology__intro}>
                    We believe benchmark transparency is a prerequisite for trust. Here is
                    exactly what we measured, how we measured it, and what we did not measure.
                </p>

                <div className={styles.methodology__grid}>
                    <div className={styles.methodCard}>
                        <h3 className={styles.methodCard__title}>What was measured</h3>
                        <p className={styles.methodCard__text}>
                            End-to-end binary event ingestion through the full production stack.
                            Each request sends a 1,656-byte pre-compiled FlatBuffer containing
                            100 events. The payload traverses HTTP parsing → Bun/Elysia routing
                            → <code>bun:ffi</code> boundary → native C columnar store. Both k6
                            and the server run on the same machine — <strong>all traffic is
                                localhost loopback, no network I/O is involved</strong>.
                        </p>
                    </div>

                    <div className={styles.methodCard}>
                        <h3 className={styles.methodCard__title}>What was NOT measured</h3>
                        <ul className={styles.methodCard__list}>
                            <li><strong>Disk I/O</strong> — The mmap store is memory-resident. Write-back is async.</li>
                            <li><strong>Query latency</strong> — Only ingestion is benchmarked here.</li>
                            <li><strong>Multi-node</strong> — Single node, no replication or sharding.</li>
                            <li><strong>TLS</strong> — Plaintext localhost. Production TLS adds latency.</li>
                            <li><strong>Network transfer</strong> — Load generator and server are co-located.</li>
                            <li><strong>eBPF probe load</strong> — Probes attached but not generating traffic.</li>
                        </ul>
                    </div>

                    <div className={styles.methodCard}>
                        <h3 className={styles.methodCard__title}>Load generator</h3>
                        <ul className={styles.methodCard__list}>
                            <li><strong>Tool:</strong> k6 v0.55</li>
                            <li><strong>VUs:</strong> 500 virtual users</li>
                            <li><strong>Duration:</strong> 50s (10s ramp, 30s sustain, 10s drain)</li>
                            <li><strong>Payload:</strong> Pre-compiled, sent from memory</li>
                            <li><strong>Transport:</strong> HTTP/1.1 localhost loopback</li>
                        </ul>
                    </div>

                    <div className={styles.methodCard}>
                        <h3 className={styles.methodCard__title}>Kernel tuning</h3>
                        <pre className={styles.methodCard__code}>{`net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
vm.max_map_count = 262144
CPU governor: performance`}</pre>
                    </div>
                </div>
            </section>

            {/* ── Footnotes ────────────────────────────────────────────────────── */}
            <footer className={styles.footnotes}>
                <div className={styles.footnotes__inner}>
                    <p><sup>1</sup> Measured on AMD Ryzen 9 8945HS, Ubuntu Server 24.04, 500 VUs,
                        50-second sustained binary ingestion via k6. Load generator and server co-located
                        on the same machine (localhost). Full methodology above.</p>
                    <p><sup>2</sup> Minisforum UM890 Pro, a consumer-grade mini PC.</p>
                    <p className={styles.footnotes__repro}>
                        Licensed under Apache 2.0. Source available for audit and verification.
                        Reproduce: <code>just build-native && just benchmark-binary</code>.
                    </p>
                </div>
            </footer>
        </div>
    );
}
