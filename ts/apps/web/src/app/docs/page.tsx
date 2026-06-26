import styles from "./page.module.css";
import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "aacyn Docs — Quickstart",
  description: "Deploy aacyn in 30 seconds. Zero code changes, zero CNI migration.",
};

const STEPS = [
  {
    title: "Install",
    commands: [
      "helm repo add aacyn https://charts.aacyn.com",
      "helm install aacyn aacyn/aacyn --namespace aacyn --create-namespace",
    ],
    detail: "Single Helm chart. Deploys the DaemonSet (eBPF probes on every node) and the aggregator.",
  },
  {
    title: "Verify",
    commands: [
      "kubectl get pods -n aacyn",
      "kubectl logs -n aacyn deployment/aacyn-aggregator",
    ],
    detail: "All pods should be Running within 30 seconds. The aggregator log shows discovered services.",
  },
  {
    title: "Open dashboard",
    commands: [
      "kubectl port-forward -n aacyn svc/aacyn 3000:3000",
      "open http://localhost:3000",
    ],
    detail: "Golden signals, topology graph, and SLO status — all from eBPF, zero instrumentation.",
  },
];

export default function DocsPage(): React.ReactElement {
  return (
    <div className={styles.page}>
      <Header />
      <header className={styles.hero}>
        <h1 className={styles.title}>Deploy in 30 seconds.</h1>
        <p className={styles.sub}>One Helm chart. Zero code changes. Works alongside any CNI.</p>
      </header>
      <section className={styles.steps}>
        {STEPS.map((step, i) => (
          <div key={step.title} className={styles.step}>
            <span className={styles.stepNumber}>{i + 1}</span>
            <div>
              <h2 className={styles.stepTitle}>{step.title}</h2>
              <p className={styles.stepDetail}>{step.detail}</p>
              <pre className={styles.codeBlock}>{step.commands.join("\n")}</pre>
            </div>
          </div>
        ))}
      </section>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Requirements</h2>
        <ul className={styles.reqList}>
          <li>Kubernetes cluster (any CNI)</li>
          <li>Linux kernel &ge; 5.15 (for eBPF CO-RE)</li>
          <li>Helm 3</li>
        </ul>
      </section>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>What you get</h2>
        <div className={styles.featureGrid}>
          {[
            { name: "Topology graph", desc: "Service dependency map from kernel-level TCP instrumentation." },
            { name: "Golden signals", desc: "Rate, errors, latency per service — no code changes." },
            { name: "SLO tracking", desc: "Error budgets and burn rate alerts out of the box." },
            { name: "Distributed tracing", desc: "eBPF-generated spans with W3C traceparent propagation." },
            { name: "OTLP export", desc: "Bridge to your existing OpenTelemetry collector." },
            { name: "Grafana plugin", desc: "Query aacyn data alongside your existing Grafana dashboards." },
          ].map((f) => (
            <div key={f.name} className={styles.featureCard}>
              <h3 className={styles.featureName}>{f.name}</h3>
              <p className={styles.featureDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
      <section className={styles.cta}>
        <p>Full documentation on <a href="https://github.com/aacyn/aacyn" className={styles.link}>GitHub</a>.</p>
        <div className={styles.ctaLinks}>
          <Link href="/architecture" className={styles.btnSecondary}>Architecture &rarr;</Link>
          <Link href="/performance" className={styles.btnSecondary}>Performance &rarr;</Link>
          <Link href="/compare" className={styles.btnSecondary}>vs Hubble &rarr;</Link>
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
