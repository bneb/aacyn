import styles from "./page.module.css";
import Link from "next/link";
import { Header } from "@/components/header";
import { LiveStatusCard } from "@/components/LiveStatusCard";

export default function LandingPage() {
  return (
    <div className={styles.landing}>
      <Header />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <header className={styles.hero}>
        <div className={styles.hero__glow} aria-hidden="true" />
        <p className={styles.hero__badge}>Zero-instrumentation monitoring</p>
        <h1 className={styles.hero__title}>
          See everything your<br />
          <span className={styles.hero__title_accent}>servers are doing.</span>
        </h1>
        <p className={styles.hero__subtitle}>
          aacyn monitors your apps and infrastructure — request rates, errors,
          response times — <strong>without touching your code</strong>.<br />
          It runs on your hardware, so your data stays yours.<br />
          Free and open source. Forever.
        </p>
        <div className={styles.hero__cta}>
          <a href="https://github.com/aacyn/aacyn" className={styles.btn_primary} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
          <Link href="/benchmarks" className={styles.btn_ghost}>
            See the benchmarks
          </Link>
        </div>
      </header>

      {/* ── What is aacyn? (3 cards) ─────────────────────────────────── */}
      <section className={styles.explainer}>
        <h2 className={styles.explainer__heading}>What is aacyn?</h2>
        <p className={styles.explainer__sub}>
          A monitoring tool that watches your servers from the operating system level —
          no SDKs to install, no code changes, no cloud account required.
        </p>
        <div className={styles.explainer__grid}>
          <div className={styles.explainer__card}>
            <span className={styles.explainer__icon}>1</span>
            <h3>Monitor</h3>
            <p>
              See every request, error, and slow response across your services.
              aacyn uses a Linux technology called eBPF to observe traffic at the
              kernel level — no agents or SDK installs needed.
            </p>
          </div>
          <div className={styles.explainer__card}>
            <span className={styles.explainer__icon}>2</span>
            <h3>Self-hosted</h3>
            <p>
              Runs on your hardware — a mini PC, a server rack, or a Docker
              container. Your telemetry data never leaves your network.
              No cloud vendor lock-in.
            </p>
          </div>
          <div className={styles.explainer__card}>
            <span className={styles.explainer__icon}>3</span>
            <h3>Free and open source</h3>
            <p>
              No per-host fees. No per-GB surcharges. No surprise invoices.
              Apache 2.0 licensed — use it, modify it, ship it.
              All features included, no tiers.
            </p>
          </div>
        </div>
      </section>

      {/* ── Proof Strip (relatable, not benchmark-y) ────────────────── */}
      <section className={styles.proof}>
        <div className={styles.proof__stat}>
          <span className={styles.proof__number}>30s</span>
          <span className={styles.proof__label}>to first dashboard</span>
        </div>
        <div className={styles.proof__divider} />
        <div className={styles.proof__stat}>
          <span className={styles.proof__number}>0</span>
          <span className={styles.proof__label}>lines of code to change</span>
        </div>
        <div className={styles.proof__divider} />
        <div className={styles.proof__stat}>
          <span className={styles.proof__number}>$0</span>
          <span className={styles.proof__label}>to get started</span>
        </div>
      </section>

      {/* ── Helm Install ──────────────────────────────────────────────── */}
      <section className={styles.demo}>
        <div className={styles.demo__text}>
          <h2 className={styles.section__heading}>
            Deploy in 30 seconds with Helm
          </h2>
          <p className={styles.section__desc}>
            One command installs the eBPF probes on every node and the dashboard
            aggregator. Works alongside any CNI — no migration needed.
          </p>
          <div className={styles.integrate__code}>
            <div className={styles.code__header}>
              <span className={styles.code__dot} />
              <span className={styles.code__dot} />
              <span className={styles.code__dot} />
              <span className={styles.code__filename}>terminal</span>
            </div>
            <pre className={styles.code__body}>{`helm repo add aacyn https://charts.aacyn.com
helm install aacyn aacyn/aacyn \\
  --namespace aacyn --create-namespace`}</pre>
          </div>
        </div>
        <div className={styles.demo__screenshot}>
          <img
            src="/dashboard-preview.png"
            alt="aacyn dashboard showing real-time topology graph with Golden Signals metrics"
            className={styles.demo__img}
          />
          <p className={styles.demo__caption}>
            Dashboard lights up automatically — services, edges, and golden signals
            discovered via eBPF with zero application code changes.
          </p>
        </div>
      </section>

      {/* ── Feature 1: Speed ─────────────────────────────────────────── */}
      <section className={styles.feature_section}>
        <div className={styles.feature_section__text}>
          <h2 className={styles.section__heading}>
            Ingest millions of events per second
          </h2>
          <p className={styles.section__desc}>
            Most monitoring tools parse JSON on every incoming request, which
            limits throughput. aacyn also accepts a compact binary format that
            skips parsing entirely — the bytes from your HTTP request go straight
            into storage.
          </p>
          <p className={styles.section__fine}>
            The result: over 5 million events per second on a single box. That&apos;s
            16× faster than JSON-only ingestion.
          </p>
        </div>
        <div className={styles.feature_section__metric}>
          <span className={styles.metric__number}>5,089,364</span>
          <span className={styles.metric__unit}>events/sec</span>
          <span className={styles.metric__context}>on a Ryzen 9 mini PC — no cloud cluster needed</span>
        </div>
      </section>

      {/* ── Feature 2: Query speed ───────────────────────────────────── */}
      <section className={`${styles.feature_section} ${styles.feature_section__reversed}`}>
        <div className={styles.feature_section__metric}>
          <span className={styles.metric__number}>286μs</span>
          <span className={styles.metric__unit}>to scan 5 million events</span>
          <span className={styles.metric__context}>
            using CPU vector instructions (SIMD) on a single core
          </span>
        </div>
        <div className={styles.feature_section__text}>
          <h2 className={styles.section__heading}>
            Query 5 million events in under a millisecond
          </h2>
          <p className={styles.section__desc}>
            aacyn stores data in a format optimized for analytics — instead of
            reading entire rows, it reads only the columns you need. Combined with
            modern CPU acceleration, this makes searching, filtering, and
            aggregating nearly instant.
          </p>
        </div>
      </section>

      {/* ── Feature 3: Data Sovereignty ──────────────────────────────── */}
      <section className={styles.sovereignty}>
        <div className={styles.sovereignty__border}>
          <h2 className={styles.section__heading}>
            Your data never leaves your network.
          </h2>
          <p className={styles.section__desc}>
            aacyn runs on your hardware and stores everything locally. There is no
            cloud backend, no telemetry, and no phoning home. Your data stays
            on your machines.
          </p>
        </div>
      </section>

      {/* ── We monitor aacyn with aacyn ──────────────────────────────────── */}
      <section className={styles.sovereignty}>
        <div className={styles.sovereignty__border}>
          <h2 className={styles.section__heading}>
            See it in action
          </h2>
          <p className={styles.section__desc}>
            Deploy aacyn on your cluster and see every TCP connection — between your services,
            your databases, and external APIs — captured at the kernel level with zero code changes.
          </p>
          <div style={{ margin: "16px 0" }}>
            <LiveStatusCard />
          </div>
          <Link href="/status" className={styles.btn_ghost} style={{ display: "inline-block" }}>
            See live status &rarr;
          </Link>
        </div>
      </section>

      {/* ── Free. Forever. ────────────────────────────────────────────── */}
      <section id="pricing" className={styles.free_section}>
        <h2 className={styles.free__title}>aacyn is free and open source.</h2>
        <p className={styles.free__sub}>
          Apache 2.0. No tiers, no limits, no phone calls from sales.
        </p>
        <ul className={styles.free__list}>
          <li>All features unlocked — Golden Signals, binary ingestion, Grafana plugin, cold storage</li>
          <li>Self-hosted, your data never leaves your network</li>
          <li>Community-supported via GitHub Discussions and Discord</li>
        </ul>
        <div className={styles.free__cta}>
          <a href="https://github.com/aacyn/aacyn" className={styles.btn_primary} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
          <Link href="/docs" className={styles.btn_ghost}>
            Quickstart &rarr;
          </Link>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
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
