import styles from "./page.module.css";
import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "aacyn Architecture — Zero Dependencies vs. The Competition",
  description:
    "See aacyn's self-contained architecture compared to Hubble, Pixie, Coroot, Beyla, and Inspektor Gadget. Fewer moving parts, fewer failure modes.",
};

interface ArchitectureStack {
  name: string;
  description: string;
  steps: string[];
  note?: string;
}

const STACKS: ArchitectureStack[] = [
  {
    name: "aacyn",
    description: "Self-contained. Deploy the binary, get everything.",
    steps: ["Helm install", "Done"],
    note: "Single binary — no external database, no time-series store, no query engine. The C columnar store handles ingest, scans, and serving in one process.",
  },
  {
    name: "Coroot",
    description: "Open-source, but requires 3 external services.",
    steps: ["Helm install", "ClickHouse", "Grafana", "Prometheus", "Done"],
    note: "ClickHouse for storage, Prometheus for metrics, Grafana for dashboards. Each dependency adds operational overhead and a failure domain.",
  },
  {
    name: "Pixie",
    description: "Great eBPF, but ties you to New Relic.",
    steps: ["Helm install", "In-cluster store", "New Relic", "Done"],
    note: "In-cluster storage handles short-term data. Long-term retention and dashboards require New Relic Cloud or a self-hosted alternative.",
  },
  {
    name: "Grafana Beyla",
    description: "eBPF with Grafana's ecosystem requirements.",
    steps: ["Helm install", "Grafana", "Prometheus / Mimir", "Done"],
    note: "Beyla emits metrics and traces; you still need Grafana for dashboards and Prometheus or Mimir for storage. Each layer must be deployed and maintained separately.",
  },
  {
    name: "Cilium Hubble",
    description: "Powerful, but requires Cilium CNI migration.",
    steps: ["Migrate CNI to Cilium", "Hubble UI", "Done"],
    note: "Hubble only works on Cilium. Migrating a production CNI is a multi-hour, high-risk operation. If you're not already on Cilium, Hubble is not an option.",
  },
  {
    name: "Inspektor Gadget",
    description: "Flexible toolkit, but not a unified platform.",
    steps: ["Install gadget", "Per-gadget config", "External dashboard", "Done"],
    note: "Each gadget is a standalone tool. No unified topology view, no built-in golden signals, no pre-configured alerts. Assembly required.",
  },
];

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={styles.arrow} aria-hidden="true">
      <path d="M8 3l5 5-5 5M13 8H3" stroke="currentColor" strokeWidth="1.5"
        fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChainBox({ label, isAacyn }: { label: string; isAacyn: boolean }) {
  return (
    <span className={`${styles.chainBox} ${isAacyn ? styles.chainBoxAacyn : ""}`}>
      {label}
    </span>
  );
}

function StackCard({ stack, isAacyn }: { stack: ArchitectureStack; isAacyn: boolean }) {
  return (
    <div className={`${styles.card} ${isAacyn ? styles.cardAacyn : ""}`}>
      <h3 className={styles.cardName}>{stack.name}</h3>
      <p className={styles.cardDesc}>{stack.description}</p>
      <div className={styles.chain}>
        {stack.steps.map((step, i) => (
          <span key={step} className={styles.chainItem}>
            <ChainBox label={step} isAacyn={isAacyn} />
            {i < stack.steps.length - 1 && <ArrowIcon />}
          </span>
        ))}
      </div>
      <p className={styles.cardNote}>{stack.note}</p>
    </div>
  );
}

export default function ArchitecturePage(): React.ReactElement {
  return (
    <div className={styles.page}>
      <Header />

      {/* Hero */}
      <header className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <h1 className={styles.heroTitle}>
          Your observability stack shouldn't have
          <span className={styles.heroAccent}> more dependencies than your app.</span>
        </h1>
        <p className={styles.heroSub}>
          Every external service you add is another thing that can break.
          aacyn is one binary — deploy it, and you're done.
        </p>
      </header>

      {/* Comparison grid */}
      <section className={styles.grid}>
        <h2 className={styles.gridTitle}>
          Dependency chains: aacyn vs. the competition
        </h2>
        <p className={styles.gridSub}>
          Count the boxes. Fewer boxes = fewer failure modes, fewer alerts,
          less YAML to maintain.
        </p>

        {/* aacyn first, highlighted */}
        <StackCard stack={STACKS[0]} isAacyn />

        {/* Everyone else */}
        <div className={styles.competitors}>
          {STACKS.slice(1).map((stack) => (
            <StackCard key={stack.name} stack={stack} isAacyn={false} />
          ))}
        </div>
      </section>

      {/* Summary CTA */}
      <section className={styles.summary}>
        <div className={styles.summaryStat}>
          <span className={styles.summaryNumber}>1</span>
          <span className={styles.summaryLabel}>binary to deploy</span>
        </div>
        <div className={styles.summaryStat}>
          <span className={styles.summaryNumber}>0</span>
          <span className={styles.summaryLabel}>external databases</span>
        </div>
        <div className={styles.summaryStat}>
          <span className={styles.summaryNumber}>30s</span>
          <span className={styles.summaryLabel}>to first golden signal</span>
        </div>
        <div className={styles.summaryActions}>
          <Link href="/docs" className={styles.btnPrimary}>
            Quickstart &rarr;
          </Link>
          <Link href="/compare" className={styles.btnSecondary}>
            Feature comparison &rarr;
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
