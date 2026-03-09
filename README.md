<p align="center">
  <h1 align="center">aacyn</h1>
  <p align="center"><strong>eBPF observability without the instrumentation. 30 seconds to your first dashboard.</strong></p>
</p>

**Hubble tells you what talked to what. aacyn tells you if it's breaking.**

<p align="center">
  <a href="https://github.com/aacyn/aacyn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aacyn/aacyn/ci.yml?branch=main&label=CI&logo=github" alt="CI"></a>
  <a href="https://github.com/aacyn/aacyn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aacyn/aacyn/ci.yml?branch=main&label=lint-ts&logo=typescript" alt="Lint TS"></a>
  <a href="https://github.com/aacyn/aacyn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aacyn/aacyn/ci.yml?branch=main&label=test-ts&logo=typescript" alt="Test TS"></a>
  <a href="https://github.com/aacyn/aacyn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aacyn/aacyn/ci.yml?branch=main&label=test-c&logo=c" alt="Test C"></a>
  <a href="https://github.com/aacyn/aacyn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aacyn/aacyn/ci.yml?branch=main&label=sanitize&logo=shield" alt="Sanitize"></a>
  <a href="https://github.com/aacyn/aacyn/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aacyn/aacyn/ci.yml?branch=main&label=fuzz&logo=bug" alt="Fuzz"></a>
  <br>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://github.com/aacyn/aacyn/releases"><img src="https://img.shields.io/github/v/release/aacyn/aacyn?logo=semver" alt="Release"></a>
</p>

## Quickstart

```bash
# 1. Clone the repo
git clone https://github.com/aacyn/aacyn
cd aacyn

# 2. Install in any Kubernetes cluster
helm install aacyn ./charts/aacyn

# 3. Forward the dashboard
kubectl port-forward svc/aacyn-dashboard 3000:3000

# 4. Open http://localhost:3000
```

Requires kernel >= 5.15 and a Kubernetes cluster with privileged DaemonSet support.

## Architecture

```
eBPF probes (kernel) → libaacyn.so (C, SoA columnar store) ←bun:ffi→ Elysia API (TS/Bun) → Next.js dashboard / Grafana plugin
```

Two primary languages, one data plane: C for the hot path (ingest, SIMD scans, eBPF consumer) and TypeScript for the control plane (API, archiver). An experimental Grafana data source plugin lives in `grafana-plugin/`.

## How it compares

| | aacyn | Hubble | Pixie | Coroot | Beyla |
|---|---|---|---|---|---|
| Golden Signals | ✅ Built-in | ❌ Manual | ❌ | ✅ | ✅ |
| Pre-configured alerts | ✅ 5 rules | ❌ | ❌ | ⚠️ SLO only | ❌ |
| SLO tracking | ✅ Error budgets | ❌ | ❌ | ✅ | ❌ |
| Distributed tracing | ✅ eBPF spans | ❌ | ✅ | ✅ | ✅ |
| gRPC visibility | ✅ Kernel-level | ✅ | ✅ | ✅ | ✅ |
| K8s pod enrichment | ✅ | ✅ | ✅ | ✅ | ✅ |
| OTLP ingest + export | ✅ Both | ❌ | ❌ | ✅ Export | ✅ Export |
| Forwarders | Datadog, Splunk, OTLP | ❌ | ❌ | ❌ | ❌ |
| No external DB | ✅ | ✅ | ❌ | ❌ ClickHouse | ✅ |
| SIMD columnar store | ✅ 5M events/s | ❌ | ❌ | ❌ | ❌ |
| Apache 2.0 | ✅ | ✅ | ✅ | ✅ | ✅ |

[Full comparison →](SPRINT_ROADMAP.md#competitive-landscape)

## Features

- **Golden Signals** — Latency, traffic, errors, saturation per-service out of the box. No dashboards to build.
- **SLO Tracking** — Define latency and error rate targets. Track error budgets and burn rates. Get alerted before you blow your SLO.
- **Distributed Tracing** — Automatic span generation from eBPF probes with W3C traceparent propagation. Waterfall view in the dashboard.
- **HTTP & gRPC visibility** — Kernel-level HTTP/1.1, HTTP/2, and gRPC parsing. Method, path, status code, service name — no sidecar needed.
- **Kubernetes pod enrichment** — Topology edges show pod names, namespaces, and deployments — not raw IPs.
- **Pre-configured alerts** — Ready-to-use alert rules for latency spikes, error bursts, and connection failures.
- **Topology graph** — Live, auto-discovered service dependency graph rendered in Canvas 2D. Updates as pods come and go.
- **Grafana plugin** — Native data source plugin. Drop aacyn metrics into existing dashboards.
- **OTLP ingest + export** — Accepts and forwards OpenTelemetry traces via HTTP/protobuf. Bridge existing instrumentation alongside eBPF data.
- **Forwarders** — Ship telemetry to Datadog, Splunk, or any OTLP-compatible collector.
- **Zero instrumentation** — No SDKs, no sidecars, no code changes. One Helm install, done.

## Install

- **Kubernetes** — `git clone` this repo, then `helm install aacyn ./charts/aacyn`. Requires kernel >= 5.15, privileged DaemonSet.
- **Docker demo** — `docker compose up` in `docker-demo/`. Full stack on a single machine — no K8s required.

## Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Agent** | C + eBPF | Zero-footprint kernel-level telemetry capture |
| **Storage** | C + mmap | Columnar event store @ 5M events/sec/node |
| **Query** | C + SIMD | AVX-512/NEON scans (286us across 5M events) |
| **API** | Elysia + Bun | Type-safe control plane with Zod validation |
| **UI** | Next.js + Canvas 2D | Live topology graph with animated edges |
| **Forwarding** | Pluggable | Datadog, Splunk, OTLP |

## Monorepo Layout

```
aacyn/
├── native/          # C engine + eBPF probes (libaacyn)
├── ts/              # Control plane & UI (TypeScript / Bun)
│   ├── apps/
│   │   ├── web/     # Next.js dashboard
│   │   └── api/     # Elysia API server
│   └── packages/
│       ├── sdk/     # Shared types & telemetry schemas
│       └── ui/      # Shared component library
├── grafana-plugin/  # Grafana data source plugin
├── charts/          # Helm chart (Kubernetes)
├── docker-demo/     # Demo stack
└── deploy/          # systemd unit for bare metal
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details. Current release: v1.0.0-dev.

## Community

- [GitHub Discussions](https://github.com/aacyn/aacyn/discussions) — questions, ideas, show and tell
- [Discord](https://discord.gg/aacyn) — real-time chat
- [Contributing](CONTRIBUTING.md) — how to build, test, and submit changes
