import styles from "./page.module.css";
import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "aacyn vs Hubble / Cilium — Comparison",
  description:
    "See how aacyn compares to Hubble and Cilium for Kubernetes observability. Setup time, features, and architecture differences.",
};

interface ComparisonRow {
  capability: string;
  aacyn: string;
  hubble: string;
  highlight?: boolean;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  {
    capability: "Setup time",
    aacyn: "30 seconds (helm install)",
    hubble: "Hours (CNI migration)",
    highlight: true,
  },
  {
    capability: "Requires CNI change",
    aacyn: "No — runs alongside any CNI",
    hubble: "Yes — requires Cilium CNI",
    highlight: true,
  },
  {
    capability: "Golden Signals (RED metrics)",
    aacyn: "Built-in — rate, errors, duration per service",
    hubble: "Manual — network flows only",
    highlight: true,
  },
  {
    capability: "SLO tracking",
    aacyn: "Error budgets + burn rate alerts",
    hubble: "No",
    highlight: true,
  },
  {
    capability: "Pre-configured alerts",
    aacyn: "5 rules out of the box",
    hubble: "Requires external tooling",
    highlight: true,
  },
  {
    capability: "Distributed tracing",
    aacyn: "eBPF span generation + W3C traceparent",
    hubble: "No",
    highlight: true,
  },
  {
    capability: "HTTP & gRPC visibility",
    aacyn: "Method, path, status, service name — kernel-level",
    hubble: "L3/L4 only (IP:port)",
    highlight: true,
  },
  {
    capability: "K8s pod enrichment",
    aacyn: "Pod names, namespaces, deployments on topology edges",
    hubble: "Yes — via Cilium identity",
  },
  {
    capability: "OTLP ingest + export",
    aacyn: "Both directions — bridge existing OTel instrumentation",
    hubble: "No",
    highlight: true,
  },
  {
    capability: "Forwarders",
    aacyn: "Datadog, Splunk, OTLP",
    hubble: "No",
    highlight: true,
  },
  {
    capability: "Grafana plugin",
    aacyn: "Native data source plugin",
    hubble: "Yes — but flow logs only",
  },
  {
    capability: "No external database required",
    aacyn: "Yes — self-contained single binary",
    hubble: "Yes — in-memory flow store",
    highlight: true,
  },
  {
    capability: "SIMD-accelerated store",
    aacyn: "AVX-512 / NEON — 5M events/sec",
    hubble: "No",
    highlight: true,
  },
  {
    capability: "Open source license",
    aacyn: "Apache 2.0",
    hubble: "Apache 2.0",
  },
  {
    capability: "Dashboard",
    aacyn: "Canvas 2D topology + golden signals + SLO gauges",
    hubble: "Service map + flow logs",
    highlight: true,
  },
];

function CheckIcon(): React.ReactElement {
  return <span className={styles.table__check}>&#10003;</span>;
}

function CrossIcon(): React.ReactElement {
  return <span className={styles.table__cross}>&#10007;</span>;
}

function getAacynDisplay(value: string): React.ReactNode {
  if (value === "Apache 2.0") {
    return <><CheckIcon /> {value}</>;
  }
  return value;
}

function getHubbleDisplay(value: string, highlight?: boolean): React.ReactNode {
  if (!highlight && value === "Apache 2.0") {
    return <><CheckIcon /> {value}</>;
  }
  if (highlight) {
    return <span className={styles.table__cell_value_muted}>{value}</span>;
  }
  return value;
}

function renderValue(
  value: string,
  isAacyn: boolean,
  highlight?: boolean,
): React.ReactNode {
  if (isAacyn) {
    return getAacynDisplay(value);
  }
  return getHubbleDisplay(value, highlight);
}

export default function ComparePage(): React.ReactElement {
  return (
    <div className={styles.page}>
      <Header />

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <header className={styles.hero}>
        <div className={styles.hero__glow} aria-hidden="true" />
        <h1 className={styles.hero__tagline}>
          Hubble tells you what talked to what.
          <span className={styles.hero__tagline_break}>
            <span className={styles.hero__tagline_accent}>
              aacyn tells you if it's breaking.
            </span>
          </span>
        </h1>
        <p className={styles.hero__subtitle}>
          Side-by-side comparison of capabilities, setup complexity, and the
          metrics you can actually act on.
        </p>
        <div className={styles.hero__cta}>
          <Link href="/docs" className={styles.btn_primary}>
            Get started in 30 seconds &rarr;
          </Link>
        </div>
        <p className={styles.hero__footnote}>
          Already using Cilium? Deploy aacyn alongside it in 30 seconds &mdash;
          no migration needed.
        </p>
      </header>

      {/* ── Comparison Table ────────────────────────────────────────────── */}
      <section className={styles.table_section}>
        <h2 className={styles.table_section__heading}>
          aacyn vs Hubble / Cilium
        </h2>
        <p className={styles.table_section__sub}>
          Two approaches to Kubernetes observability: network flows versus
          service-level Golden Signals. aacyn also compares favorably to
          Pixie, Coroot, and Grafana Beyla — see the
          README for the full competitive matrix.
        </p>

        <div className={styles.table}>
          <div className={styles.table__header}>
            <span className={styles.table__header_capability}>Capability</span>
            <span className={styles.table__header_product}>aacyn</span>
            <span className={styles.table__header_product}>Hubble</span>
          </div>

          {COMPARISON_ROWS.map((row) => (
            <div key={row.capability} className={styles.table__row}>
              <span className={styles.table__cell_capability}>
                {row.capability}
              </span>
              <span
                className={`${styles.table__cell_value} ${row.highlight ? styles.table__cell_value_highlight : ""}`}
              >
                {renderValue(row.aacyn, true, row.highlight)}
              </span>
              <span className={styles.table__cell_value}>
                {renderValue(row.hubble, false, row.highlight)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA Section ────────────────────────────────────────────────── */}
      <section className={styles.cta_section}>
        <h2 className={styles.cta_section__title}>
          Get started in 30 seconds.
        </h2>
        <p className={styles.cta_section__sub}>
          Zero code changes. Zero CNI migration. Zero vendor lock-in.
        </p>
        <div className={styles.cta_section__actions}>
          <Link href="/docs" className={styles.btn_primary}>
            Quickstart &rarr;
          </Link>
        </div>
        <p className={styles.cta_section__footnote}>
          Already using Cilium? aacyn runs alongside any CNI &mdash; deploy it
          on your existing cluster with <strong>helm install</strong> and your
          Hubble data keeps flowing.
        </p>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className={styles.footer}>
        <span className={styles.footer__brand}>aacyn</span>
        <div className={styles.footer__links}>
          <Link href="/benchmarks">Benchmarks</Link>
          <Link href="/docs">Docs</Link>
        </div>
      </footer>
    </div>
  );
}
