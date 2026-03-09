# Changelog

All notable changes to aacyn are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

> **Note:** aacyn was originally developed as a commercial product with license keys, Stripe billing, and tiered features. As of v1.0.0-dev, it is free and open source under Apache 2.0. All commercial code (Stripe, Ed25519 licensing, heartbeat, tier gates, RBAC) has been removed. The entries below for versions prior to v1.0.0-dev document features that no longer exist in the current codebase.

## [0.8.1] — 2026-06-18

> ⚠️ Many features described in this release were removed in the v1.0.0-dev Apache 2.0 relicense.

### Added
- **Stripe Webhook Signature Verification** — HMAC-SHA256 verification on both the Elysia server and Cloudflare Worker. Webhooks are now cryptographically verified before processing. Timestamp replay protection (±5 min tolerance).
- **API Key Authentication** — Bearer token auth on all non-health routes. Controlled via `AACYN_API_KEY` env var. When unset (development), auth is transparently disabled.
- **Request ID Middleware** — Every request gets a unique `X-Request-Id` for log correlation.
- **Prometheus Metrics Endpoint** — `GET /v1/metrics` exposes counters, histograms, and gauges in Prometheus text format. Dogfoods our own columnar store principles — zero external dependencies.
- **Deep Health Check** — `GET /health` now reports native store status, eBPF probe status, license validity, eBPF ring buffer drops, and archiver lag.
- **Structured Logging** — JSON logger (`lib/logger.ts`) with subsystem tagging and request ID correlation. Emoji-prefixed development mode, pure JSON in production.
- **IStore Interface** — Canonical store interface in `@aacyn/sdk` implemented by both NativeStore (FFI→C) and V8MapStore (TS fallback). Foundation for eliminating `as any` casts.
- **Multi-Node Aggregator** — `lib/aggregator.ts` with IP-based cross-node topology merging, edge deduplication, and golden signal aggregation. Node push client with exponential backoff.
- **Upstream Forwarder Abstraction** — `lib/forwarder.ts` with pluggable forwarder interface for Datadog and Splunk. Configured via `aacyn.toml`.
- **RBAC Module** — `lib/rbac.ts` with Viewer/Operator/Admin roles. Path-to-role mapping for API endpoints. SSO group integration.
- **Helm Chart** — `charts/aacyn/` with DaemonSet (eBPF node agent) and Deployment (central aggregator). Ready for `helm install`.
- **systemd Service Unit** — `deploy/systemd/aacyn.service` for bare metal / VM deployments.
- **`.env.local.example`** — Template for development environment variables. No more placeholder secrets committed to git.

### Changed
- **LICENSE_SALT** now crashes on startup in production if unset (was: silent fallback to `"aacyn-dev-salt"`).
- **5 empty catch blocks** now log the error message before continuing (was: silent swallowing).
- **CI pipeline** now includes dependency audit and secrets scan jobs.
- **Server startup** shows v0.8.1 version string.

### Fixed
- Stripe webhook endpoint now verifies HMAC-SHA256 signatures before processing (was: trusted header presence alone).
- Cloudflare Worker Stripe webhook handler now uses Web Crypto API for proper HMAC verification.

## [0.8.0] — 2026-03-12

> ⚠️ Many features described in this release were removed in the v1.0.0-dev Apache 2.0 relicense.

### Added
- **Hybrid Offline-First Licensing** — Ed25519 signed license is now the primary auth mechanism. License payload includes `exp` (expiry timestamp) and `tier` (free/pro/team/enterprise). Verifies locally in microseconds with zero network requests.
- **Tier-Aware Feature Gates** — `hasFeature()` API replaces binary `isLicenseValid()`. Features like Grafana queries, eBPF auto-discovery, and cold storage archival are gated per tier.
- **Auto-Renewal via Heartbeat** — The daily heartbeat ping is now optional. When online, it auto-renews the Ed25519 license before expiry. Air-gapped deployments work indefinitely with the signed key.
- **Stripe Tier Detection** — Webhook handler maps Stripe Price IDs to license tiers and embeds them in the Ed25519 payload.
- **Golden Signals** — Per-service RED metrics (rate, error count, duration) computed from eBPF data. Displayed in the dashboard topology view.
- **Docker Demo Screenshot** — Clean dashboard screenshot integrated into the landing page.
- **88 Automated Tests** — 329 assertions covering the complete licensing pipeline including Ed25519 minting, verification, expiry, tier feature gates, and Stripe webhooks.

### Changed
- **Marketing Site** — Problem-first messaging: "See everything your servers are doing." Added explainer cards, pricing comparison table, Docker demo section with real dashboard screenshot, and relatable proof strip (30s / 0 lines / $0).
- **License Email** — Now instructs customers to use the Ed25519 key directly (`AACYN_LICENSE_KEY=<signed_key>`), not the legacy heartbeat key.
- **Documentation** — Updated QUICKSTART, configuration reference, API reference, operations runbook, and contact page to reflect the offline-first licensing model.

### Deprecated
- **Heartbeat-only licensing** — The SHA-256 heartbeat key is retained for backwards compatibility but is no longer the primary auth mechanism. New installations should use the Ed25519 key.

---

## [0.5.0] — 2026-03-09

> ⚠️ Many features described in this release were removed in the v1.0.0-dev Apache 2.0 relicense.

### Added
- **eBPF Kernel Probes** — Zero-instrumentation network telemetry via `tracepoint/syscalls/sys_enter_connect`, `sys_exit_connect`, and `kprobe/tcp_sendmsg`. Captures outbound TCP connections, connection latency, and bytes sent. Auto-attaches on server startup when BPF object is present.
- **AVX-512 Scan Benchmark** — 5M event columnar scan in 286μs (17.5B effective events/sec). Added to `BENCHMARKS.md` and `/benchmarks` marketing page.
- **Heartbeat License System** — Cloudflare Worker + KV for license validation. SHA-256 key derivation, 7-day grace period, daily heartbeat ping.
- **Resend Email Integration** — License key delivery via transactional email with styled HTML template.
- **Ed25519 Offline Licensing** — Cryptographic license minting and verification.
- **Binary Siege Benchmark** — 5.09M events/sec with 16ms p99 latency on AMD Ryzen 9 (Zen 4).
- **Benchmarks Marketing Page** — `/benchmarks` with industry comparisons (Datadog, ClickHouse, Vector).
- **Apache 2.0 License** — Full Apache License 2.0 for complete open source freedom.
- **Build-Appliance Target** — `just build-appliance` produces a self-contained binary.
- **Comprehensive Documentation** — `QUICKSTART.md`, API reference, configuration reference, operations runbook, binary protocol guide, eBPF guide.
- **Environment Configuration** — `.env.production`, `.env.local`, `.env.test` with structured hierarchy.
- **32 Automated Tests** — Licensing pipeline fully covered: minting, delivery, heartbeat validation, Stripe webhooks, checkout edge cases, end-to-end flow.

### Changed
- **Makefile Linker Ordering** — Separated `LDFLAGS` (pre-source) from `LDLIBS` (post-source) to fix the classic GCC left-to-right symbol resolution issue. `-lbpf -lelf -lz` now correctly appear after the source file.
- **eBPF Probe Source** — Added `#define AF_INET 2` for BPF compilation context where `vmlinux.h` doesn't include socket constants.

### Fixed
- **5 Audit Bugs** — Addressed critical vulnerabilities identified in technical due diligence.
- **`getpagesize` Warning** — Harmless implicit declaration warning in `libaacyn.c` (missing `<unistd.h>`).
- **Benchmarks Page Footnote** — Updated from BSL to Apache 2.0 reproduction instructions.

---

## [0.4.0] — 2026-03-04

### Added
- **Native Columnar Store** — `libaacyn.c` with mmap'd Struct-of-Arrays layout. 16M event capacity in 198MB.
- **AVX-512 SIMD Scans** — Vectorized column reads for `scan_duration_max`, `scan_error_count`, `scan_duration_filter`.
- **Binary Ingestion** — FlatBuffer wire format for zero-parse, zero-copy event ingestion.
- **JSON Batch Ingestion** — `POST /ingest/batch` with TypeBox schema validation.
- **Trace Lookup** — `GET /query/trace/:traceId` with O(1) hash index.
- **WebGPU Dashboard** — Real-time telemetry visualization (sovereign, client-side rendering).
- **Stripe Checkout** — `POST /api/checkout` creates subscription sessions.
- **Landing Page** — Marketing site with hero section, feature grid, and CTA.

---

## [0.1.0] — 2026-02-15

### Added
- Initial project scaffolding
- Bun monorepo with `apps/api`, `apps/web`, `packages/sdk`, `packages/ui`
- Elysia API server with health check
- Next.js 16 web application
- Tailwind CSS v4 design system
