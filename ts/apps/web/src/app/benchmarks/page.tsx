import styles from "./page.module.css";
import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "aacyn Benchmarks — 5M events/sec",
  description: "Reproducible benchmark methodology and results for aacyn's SIMD-accelerated columnar store.",
};

const INGESTION = [
  ["Throughput", "5,089,364 events/sec"],
  ["p95 Latency", "12.73ms"],
  ["p99 Latency", "16.12ms"],
  ["Error Rate", "0.00%"],
  ["Hardware", "Minisforum UM890 Pro, Ryzen 9 8945HS, 32GB DDR5"],
];

const SCANS = [
  ["scan_duration_max", "286μs", "402μs", "17.5B events/sec"],
  ["scan_error_count", "35μs", "60μs", "141.6B events/sec"],
  ["scan_duration_filter", "298μs", "415μs", "16.8B events/sec"],
];

const VS_JSON = [
  ["JSON (Path A)", "314K evt/sec", "218.79ms"],
  ["Binary (Path B)", "5.09M evt/sec", "12.73ms"],
];

export default function BenchmarksPage(): React.ReactElement {
  return (
    <div className={styles.page}>
      <Header />
      <header className={styles.hero}>
        <h1 className={styles.title}>Benchmarks</h1>
        <p className={styles.sub}>
          All measurements from a single consumer mini PC. Methodology and reproducibility
          instructions in the repository.
        </p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Binary Ingestion</h2>
        <p className={styles.sectionSub}>500 VUs, 50s sustained, FlatBuffer payload, localhost loopback.</p>
        <div className={styles.table}>
          {INGESTION.map(([label, value]) => (
            <div key={label} className={styles.row}>
              <span className={styles.label}>{label}</span>
              <span className={styles.value}>{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>SIMD Scan Performance</h2>
        <p className={styles.sectionSub}>5M events, 62MB columnar data, AVX-512.</p>
        <div className={styles.table}>
          <div className={styles.row + " " + styles.header}>
            <span className={styles.label}>Operation</span>
            <span className={styles.value}>Median</span>
          </div>
          {SCANS.map(([op, median, p99, rate]) => (
            <div key={op} className={styles.row}>
              <span className={styles.label}>{op}</span>
              <span className={styles.value}>{median} median, {p99} p99, {rate}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Binary vs JSON</h2>
        <div className={styles.table}>
          {VS_JSON.map(([label, throughput, p95]) => (
            <div key={label} className={styles.row}>
              <span className={styles.label}>{label}</span>
              <span className={styles.value}>{throughput}, p95: {p95}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.cta}>
        <p>Full methodology and reproducibility instructions in the repository.</p>
        <div className={styles.ctaLinks}>
          <Link href="/performance" className={styles.btnSecondary}>How it works &rarr;</Link>
          <Link href="/docs" className={styles.btnSecondary}>Quickstart &rarr;</Link>
        </div>
      </section>

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
