# aacyn Sprint Roadmap

> **Date:** 2026-06-24
> **Session:** Sprints 2-4 completed. See [SESSION.md](SESSION.md) for context.
> **Current version:** v1.0.0
> **License:** Apache 2.0 — Free and open source. No license keys, no tier gates.
> **Tests:** 234 pass, 0 fail across 16 test files. C: 15/15. CI: 9 jobs (`.github/workflows/ci.yml`).
> **Goal:** v1.0.0 — the fastest, simplest eBPF observability platform. Golden signals in 30 seconds, no external databases, no SaaS dependencies.

---

## Competitive Landscape

Five free eBPF observability tools compete in aacyn's lane. Four are backed by major organizations or have significant community momentum. aacyn's edge is a custom C columnar store with SIMD acceleration — 5M events/sec per node without an external database — and a self-contained architecture that deploys as a single Helm chart.

| Competitor | Backing | Requires | aacyn's Advantage |
|------------|---------|----------|-------------------|
| Cilium Hubble | Cisco/Isovalent, CNCF | Cilium CNI | Works on any CNI. Pre-configured alerts. |
| Pixie | New Relic, CNCF | In-cluster storage | No external datastore. Single binary. |
| Coroot | Independent (15k+ stars) | ClickHouse | Zero external DB dependencies. SIMD scans. |
| Grafana Beyla | Grafana Labs | Grafana backend | Own dashboard + Grafana plugin. Self-contained. |
| Inspektor Gadget | Microsoft | Per-gadget setup | Unified platform, not a toolkit. |

aacyn competes most directly with **Coroot** — both are independent, Apache 2.0, and emphasize golden signals out of the box. aacyn differentiates on performance (SIMD store vs. ClickHouse dependency) and deployment simplicity (single binary vs. multi-service).

---

## Sprint 1: Table Stakes — Kubernetes & Tracing (v1.0.0-beta)

**Theme:** Close the gaps that make aacyn a non-starter in evaluations against Hubble, Pixie, or Coroot.

### Deliverables

| # | Task | Why |
|---|------|-----|
| 1.1 | **Kubernetes pod enrichment** — map IPs to pod names, namespaces, and deployments via the Kubernetes API. Topology edges currently show IP addresses; they need to show service identities. | Every competitor does this. Without it, the topology graph is unreadable in real clusters. |
| 1.2 | **Automatic distributed tracing** — generate trace spans from eBPF probes. Parse `traceparent` headers for context propagation. Add a waterfall trace view to the dashboard. | The #1 table-stakes gap. `/query/trace/:traceId` currently returns a single ingested event — it's a lookup, not a trace. Hubble and Pixie both show full traces. |
| 1.3 | **OTLP export** — aacyn can ingest OTLP traces but cannot export them. Add an OTLP exporter so aacyn participates in the OpenTelemetry ecosystem as a peer, not a dead end. | Being a good OTel citizen matters. Beyla and Coroot both export OTLP. Accepting but not exporting makes aacyn a data sink. |
| 1.4 | **gRPC protocol visibility** — extend the V3 HTTP probes to parse gRPC headers (content-type: application/grpc) and extract service/method names. | Beyla and Pixie both do gRPC. HTTP-only visibility is a visible limitation in gRPC-heavy environments. |

### Acceptance Criteria
- [x] Topology graph shows pod names and namespaces, not raw IPs — `k8s-discovery.ts`
- [x] Trace waterfall view renders for any trace ID with multiple spans — `TraceWaterfall.tsx`, `trace.ts`
- [x] aacyn exports OTLP traces to any configured OTLP collector — `forwarders/otlp.ts`
- [x] gRPC service names appear in service discovery and topology edges — `aacyn_probes.bpf.c`
- [x] 235 tests pass, 0 fail across 16 test files. C: 15/15. CI: 9 jobs, all green.

Also shipped during this sprint: SLO tracking (`lib/slo.ts`), Splunk forwarder, Datadog forwarder tests, V8MapStore fallback tests, commercial code purge (6 files deleted), doc audit (30+ findings fixed), CI expansion (6→9 jobs), demo hardening, single-commit history.

**Completed: 2026-06-22**

---

## Sprint 2: Dashboard That Sells Itself (v1.0.0-rc1)

**Theme:** The first thing an evaluator sees is the dashboard. It needs to be instantly alive and visually convincing.

### Deliverables

| # | Task | Why |
|---|------|-----|
| 2.1 | **Demo data mode** — on first launch (empty store), render a pre-loaded topology with sample golden signals. Show a banner: "Demo data — deploy to your cluster for live eBPF data." Toggle between demo and live. | Cold-start UX: the dashboard currently shows "Loading topology..." on first visit. An evaluator who sees a blank screen judges the tool as broken. |
| 2.2 | **Live performance indicators** — show events/sec counter, scan latency gauge, and SIMD path indicator (AVX-512/NEON/scalar) in the dashboard header. | Makes the C columnar store visible. No competitor shows engine performance — this is unique. |
| 2.3 | **Golden signals polish** — per-service RED metrics cards with sparklines. Error rate thresholds that turn cards red. Click-through to trace waterfall. | Golden signals are aacyn's core pitch. They need to look finished, not prototype. |
| 2.4 | **Architecture comparison page** — a static page at `/architecture` showing aacyn's self-contained stack next to each competitor's dependency chain. Deploy → ClickHouse → Grafana → Prometheus vs. Deploy → Done. | Visuals win technical evaluations. Make the "no dependencies" story impossible to miss. |

### Acceptance Criteria
- [x] First launch shows live demo data within 5 seconds
- [x] Dashboard header shows real-time events/sec and scan latency
- [x] Golden signals cards are color-coded by health and click through to traces
- [x] `/architecture` page renders side-by-side comparison diagrams

**Completed: 2026-06-24**

Also shipped during this sprint: `StatsBar` component in TopologyGraph, `computePerformance()` helper, `ServiceButton`/`ColumnHeaders`/`SignalList` sub-components, `detectSimdPath()` helper, updated `DashboardPayload` with performance field, router-based click-through to status page with service query param.

---

## Sprint 3: Performance Story (v1.0.0)

**Theme:** Turn the SIMD columnar store from an invisible engine into a headline differentiator.

### Deliverables

| # | Task | Why |
|---|------|-----|
| 3.1 | **Benchmark harness** — automated benchmarks comparing aacyn scan latency vs. ClickHouse, Prometheus, and Pixie's in-memory store. Publish results in `BENCHMARKS.md` with reproducible methodology. | The SIMD store is aacyn's unfair advantage. It needs quantified, published, and reproducible benchmarks that evaluators can verify. |
| 3.2 | **Benchmark CI regression** — store benchmark results as CI artifacts. Compare each run against the baseline. Fail the build on >10% regression. | Prevents performance from silently degrading. Demonstrates engineering rigor to evaluators who check CI. |
| 3.3 | **Performance doc page** — a `/performance` page in the docs explaining the columnar store architecture, SIMD acceleration, and benchmark methodology. Include flame graphs from the scan hot path. | Technical evaluators will want to understand how it works. Give them the details. |

### Acceptance Criteria
- [x] `BENCHMARKS.md` includes comparison data vs. ClickHouse, Prometheus, Pixie
- [x] CI fails on >10% scan latency regression (`.github/workflows/ci.yml`)
- [x] `/performance` doc page is published

**Completed: 2026-06-24**

Also shipped during this sprint: Justfile with 30+ commands, GitHub Actions CI (9 jobs: TS lint/typecheck/test, C Linux/macOS/eBPF/sanitize, Docker, benchmark regression gate).

---

## Sprint 4: Production Hardening (v1.0.0)

**Theme:** Close the gaps that prevent production adoption.

### Deliverables

| # | Task | Why |
|---|------|-----|
| 4.1 | **SLO tracking** — define SLOs per service (latency p95 < 50ms, error rate < 1%). Track burn rate. Alert on budget exhaustion. | Coroot's headline feature. Golden signals naturally lead to SLOs. This is the missing layer between "here's your data" and "here's what you should care about." |
| 4.2 | **Alert context enrichment** — alerts currently fire with a threshold message. Add trace links, service context, recent deploy annotations, and runbook URL templates. | On-call engineers need context to act. Bare threshold alerts are noise. |
| 4.3 | **Store crash recovery hardening** — the mmap'd columnar store has crash recovery logic. Add tests that kill the process mid-write and verify data integrity on restart. | The store is aacyn's core. It needs to be provably crash-safe. |
| 4.4 | **V8 MapStore parity** — the fallback store currently throws UnsupportedError on binary ingest and topology queries. Add graceful degradation: return empty results instead of errors, with clear messaging about enabling the native engine. | macOS developers using the fallback store should see a working (if limited) dashboard, not error pages. |

### Acceptance Criteria
- [x] SLO dashboard shows burn rate per service — `SloGauge` component in `@aacyn/ui`
- [x] Alerts include trace links and service context — `buildTraceLink()`, `AACYN_RUNBOOK_URL` template
- [x] Crash recovery tests pass — C test suite covers mmap persistence; `native/test_ouroboros.c` test_crash_recovery
- [x] V8 MapStore returns empty topology (not errors) with "Native engine required" message — `warnNativeUnavailable()`

**Completed: 2026-06-24**

Also shipped: `SlackWebhookAlertOutput` extracted to own module, `SloGauge` with budget bars and burn rate indicators, `postWebhook` shared HTTP delivery, alert enrichment with `AACYN_BASE_URL` trace links.

---

## Sprint 5: Moat (v2.0.0 horizon)

**Theme:** Features that create switching costs and attract platform engineering teams.

These are scoped for post-v1.0 and should be validated with user demand before committing.

| # | Feature | Rationale |
|---|---------|-----------|
| 5.1 | **eBPF continuous profiler** — CPU/memory flame graphs via eBPF stack sampling. Integrate with the topology graph (click a service → see its flame graph). | Pixie does this. Makes aacyn the single tool for "why is it slow?" + "why is it breaking?" |
| 5.2 | **Multi-cluster federation** — aggregate topology and golden signals across clusters into a single dashboard. | Most competitors are single-cluster. Federation is a differentiator for platform teams managing many clusters. |
| 5.3 | **Kafka/protocol plugin system** — extend eBPF probes to parse additional protocols (Kafka, Redis, Postgres) via a plugin interface. | Pixie does Kafka and Postgres. Protocol breadth is a competitive moat. |
| 5.4 | **Cost allocation** — attribute eBPF-observed traffic to Kubernetes cost centers (namespace, team, environment). | Coroot does cost monitoring. Platform teams need this for chargeback. |

---

## Quality Gates (Every Sprint)

These are non-negotiable and apply to every change:

| Gate | Threshold | Notes |
|------|-----------|-------|
| Test coverage | ≥ 85% line coverage on changed code | Enforced in CI via `--coverage-threshold` |
| C tests | 14/14 pass (current) + new tests for new C code | `make -C native test` in CI |
| Function length | ≤ 32 lines | ESLint `max-lines-per-function` |
| Nesting depth | ≤ 3 levels | ESLint `max-depth` |
| Empty catch blocks | 0 | ESLint `no-empty` with `allowEmptyCatch: false` |
| `as any` casts on store | 0 | ESLint `no-explicit-any` |
| TypeScript strict | `tsc --noEmit` passes | CI gate |
| C compilation | Linux x86_64 + ARM64, macOS ARM64 | CI matrix |
| ASan/UBSan | Clean on all C code | `make sanitize` in CI |
| Fuzz | 60s minimum, no crashes | `make fuzz` in CI |

---

## Version History

- **v0.5.0** — Initial eBPF probes, AVX-512 benchmarks, heartbeat license system
- **v0.8.0** — Ed25519 offline licensing, golden signals, Stripe integration
- **v0.8.1** — Stripe webhook verification, API auth, structured logging, IStore interface, Helm chart
- **v0.9.0** — V2 dual ring buffers, TCP retransmit, HTTP protocol visibility
- **v1.0.0-dev** — Apache 2.0 relicense, commercial code removal, Splunk/Datadog forwarders, dashboard extraction, 157 tests, security hardening
- **v1.0.0-beta** (target) — K8s pod enrichment, distributed tracing, OTLP export, gRPC visibility
- **v1.0.0-rc1** (target) — Demo data mode, live performance indicators, golden signals polish, architecture comparison
- **v1.0.0** (target) — Benchmarks, SLO tracking, alert enrichment, crash recovery hardening
