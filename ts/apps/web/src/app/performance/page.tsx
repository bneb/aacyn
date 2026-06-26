import styles from "./page.module.css";
import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "aacyn Performance — 5M events/sec on a single box",
  description:
    "How aacyn's SIMD-accelerated columnar store achieves 5 million events/sec with sub-millisecond scan latency on consumer hardware.",
};

interface BenchmarkFigure {
  label: string;
  value: string;
  detail: string;
}

const HEADLINE_FIGURES: BenchmarkFigure[] = [
  { label: "Ingestion throughput", value: "5,089,364", detail: "events/sec — single consumer mini PC" },
  { label: "Scan latency (max duration)", value: "286μs", detail: "across 5M events — AVX-512, 16 floats/cycle" },
  { label: "Scan latency (error count)", value: "35μs", detail: "across 5M events — uint8 column fits in L2 cache" },
  { label: "p99 ingestion latency", value: "16ms", detail: "at 50K concurrent requests/sec" },
  { label: "Error rate under load", value: "0.00%", detail: "254M events, zero errors, zero drops" },
];

interface ScanRow {
  operation: string;
  median: string;
  p99: string;
  effectiveRate: string;
}

const SCAN_TABLE: ScanRow[] = [
  { operation: "scan_duration_max", median: "286μs", p99: "402μs", effectiveRate: "17.5B events/sec" },
  { operation: "scan_error_count", median: "35μs", p99: "60μs", effectiveRate: "141.6B events/sec" },
  { operation: "scan_duration_filter (>10ms)", median: "298μs", p99: "415μs", effectiveRate: "16.8B events/sec" },
];

const ARCH_STEPS = [
  {
    title: "Columnar (SoA) layout",
    desc: "Timestamps, durations, and error flags are stored in separate contiguous arrays — not interleaved rows. The CPU prefetcher sees a straight line through memory. No pointer chasing, no cache misses from mixed-type rows.",
  },
  {
    title: "mmap'd ring buffer",
    desc: "The entire store is backed by a memory-mapped file. The OS manages write-back to disk asynchronously. On restart, the ring buffer is recovered directly from the page cache — no replay, no WAL, no recovery log.",
  },
  {
    title: "FlatBuffer binary protocol",
    desc: "Events are ingested as pre-serialized FlatBuffer payloads — 16 bytes per event, no JSON parsing. The C engine reads the buffer with a bounds check and memcpy's directly into the column arrays. Zero allocation in the hot path.",
  },
  {
    title: "AVX-512 / NEON SIMD scans",
    desc: "Queries compile to SIMD intrinsics at build time. AVX-512 processes 16 floats per instruction; NEON processes 4. Both paths have a scalar fallback. The scan_duration_max function reads 5M floats in 286μs — that's 17.5 billion effective events/sec of scan bandwidth.",
  },
  {
    title: "bun:ffi — zero-copy FFI",
    desc: "TypeScript calls into C through Bun's FFI layer with a raw pointer. No serialization, no V8 GC pressure, no context switching. The TS side passes a pointer; the C side writes directly into the output buffer. Round-trip is measured in nanoseconds.",
  },
];

function FigureCard({ figure }: { figure: BenchmarkFigure }) {
  return (
    <div className={styles.figureCard}>
      <span className={styles.figureValue}>{figure.value}</span>
      <span className={styles.figureLabel}>{figure.label}</span>
      <span className={styles.figureDetail}>{figure.detail}</span>
    </div>
  );
}

export default function PerformancePage(): React.ReactElement {
  return (
    <div className={styles.page}>
      <Header />

      {/* Hero */}
      <header className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <h1 className={styles.heroTitle}>
          The columnar store is the{" "}
          <span className={styles.heroAccent}>unfair advantage.</span>
        </h1>
        <p className={styles.heroSub}>
          Every other eBPF observability tool routes data to an external database.
          aacyn keeps it in-process — a custom C columnar store with SIMD acceleration
          that ingests 5M events/sec and scans 5M rows in under 300 microseconds.
        </p>
      </header>

      {/* Headline figures */}
      <section className={styles.figuresSection}>
        <h2 className={styles.sectionTitle}>Benchmark Results</h2>
        <p className={styles.sectionSub}>
          All measurements from a single Minisforum UM890 Pro (Ryzen 9 8945HS, 32GB DDR5).
          Full methodology and reproducibility instructions in{" "}
          <Link href="/benchmarks" className={styles.inlineLink}>
            BENCHMARKS.md
          </Link>.
        </p>
        <div className={styles.figuresGrid}>
          {HEADLINE_FIGURES.map((f) => (
            <FigureCard key={f.label} figure={f} />
          ))}
        </div>
      </section>

      {/* Scan performance table */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>SIMD Scan Performance</h2>
        <p className={styles.sectionSub}>
          5 million events · 62MB columnar data · AVX-512 on AMD Ryzen 9 8945HS.
          All scans complete in under half a millisecond at p99.
        </p>
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Operation</span>
            <span>Median</span>
            <span>p99</span>
            <span>Effective Rate</span>
          </div>
          {SCAN_TABLE.map((row) => (
            <div key={row.operation} className={styles.tableRow}>
              <span className={styles.tableOp}>{row.operation}</span>
              <span>{row.median}</span>
              <span>{row.p99}</span>
              <span>{row.effectiveRate}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture deep dive */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>How It Works</h2>
        <p className={styles.sectionSub}>
          Five design decisions that eliminate the bottlenecks in traditional observability pipelines.
        </p>
        <div className={styles.archGrid}>
          {ARCH_STEPS.map((step, i) => (
            <div key={step.title} className={styles.archCard}>
              <span className={styles.archNumber}>{i + 1}</span>
              <div>
                <h3 className={styles.archTitle}>{step.title}</h3>
                <p className={styles.archDesc}>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Industry comparison */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Industry Comparison</h2>
        <p className={styles.sectionSub}>
          Directionally valid comparisons from publicly documented benchmarks.
        </p>
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Platform</span>
            <span>Throughput</span>
            <span>Hardware</span>
          </div>
          <div className={`${styles.tableRow} ${styles.tableRowHighlight}`}>
            <span className={styles.tableOp}>aacyn</span>
            <span>5,089,364 evt/sec</span>
            <span>1× mini PC (8C/16T)</span>
          </div>
          <div className={styles.tableRow}>
            <span className={styles.tableOp}>ClickHouse (logs)</span>
            <span>~120,000 rows/sec</span>
            <span>Single node (8C, 16GB)</span>
          </div>
          <div className={styles.tableRow}>
            <span className={styles.tableOp}>Vector (Datadog)</span>
            <span>~76 MiB/sec</span>
            <span>File-to-TCP pipeline</span>
          </div>
        </div>
        <p className={styles.comparisonNote}>
          These are different workloads — ClickHouse persists to disk with full indexing; Vector routes bytes
          through a pipeline. aacyn&apos;s advantage is architectural: by keeping data in columnar memory and
          avoiding external database round-trips, it eliminates the largest sources of latency in observability
          pipelines. See BENCHMARKS.md for detailed apples-to-apples notes.
        </p>
      </section>

      {/* Binary vs JSON */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Binary Protocol vs. JSON</h2>
        <p className={styles.sectionSub}>
          The same ingestion pipeline, comparing FlatBuffer binary payloads against equivalent JSON.
        </p>
        <div className={styles.comparisonCards}>
          <div className={styles.comparisonCard}>
            <span className={styles.comparisonLabel}>JSON (Path A)</span>
            <span className={styles.comparisonValue}>314K evt/sec</span>
            <span className={styles.comparisonDetail}>p95: 218.79ms</span>
          </div>
          <div className={styles.comparisonArrow}>→</div>
          <div className={`${styles.comparisonCard} ${styles.comparisonCardWinner}`}>
            <span className={styles.comparisonLabel}>Binary (Path B)</span>
            <span className={styles.comparisonValue}>5.09M evt/sec</span>
            <span className={styles.comparisonDetail}>p95: 12.73ms</span>
          </div>
          <div className={styles.comparisonImprovement}>
            <span className={styles.improvementValue}>16.2×</span>
            <span className={styles.improvementLabel}>throughput improvement</span>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className={styles.cta}>
        <h2 className={styles.ctaTitle}>Reproduce the benchmarks yourself.</h2>
        <p className={styles.ctaSub}>
          Everything is open source. The benchmark harness, the data generator, and the
          methodology are all in the repository.
        </p>
        <div className={styles.ctaActions}>
          <Link href="/benchmarks" className={styles.btnPrimary}>
            BENCHMARKS.md &rarr;
          </Link>
          <Link href="/architecture" className={styles.btnSecondary}>
            Architecture comparison &rarr;
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <span className={styles.footerBrand}>aacyn</span>
        <div className={styles.footerLinks}>
          <Link href="/benchmarks">Benchmarks</Link>
          <Link href="/docs">Docs</Link>
        </div>
      </footer>
    </div>
  );
}
