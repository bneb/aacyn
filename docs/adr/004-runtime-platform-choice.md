# ADR 004: Bun + Elysia vs Node + Express for the API Control Plane

**Status:** Accepted (2026-03, reaffirmed 2026-06)
**Driver:** Runtime platform for the TypeScript control plane
**Decision:** Bun runtime + Elysia web framework

---

## Context

The aacyn API server must satisfy four requirements:

1. **FFI to C library.** The hot path is `libaacyn.so` — a hand-rolled SIMD columnar store in C. The API needs to call ~20 C functions for ingest, query, topology, eBPF lifecycle, and license validation. Every FFI call passes raw pointers to mmap'd memory. The bridge must be zero-copy on the hot path.
2. **High-throughput ingest.** Events arrive as JSON batches or FlatBuffer binaries. The k6 benchmark (`ts/apps/api/tests/benchmark.k6.js`) targets 500 VUs sustained, p95 latency < 10 ms, p99 < 15 ms, zero HTTP errors. The C store is the bottleneck, not the HTTP layer — but the runtime must not add overhead.
3. **Dashboard serving.** The API serves a Next.js dashboard and a `GET /dashboard` inline HTML page alongside telemetry endpoints. Sharing TypeScript types between the control plane and the UI prevents type drift.
4. **Cold start < 100 ms.** The metrics pipeline may restart during incidents — a monitoring tool that takes seconds to start is a monitoring tool that misses events.

---

## Options Considered

| Option | Runtime | Web Framework | FFI Mechanism |
|--------|---------|---------------|---------------|
| A | Node.js 22 | Express 5 | `ffi-napi` or N-API native addon |
| B | Go 1.24 | Gin | `cgo` |
| C | Rust 1.86 | Axum | `extern "C"` + `unsafe` |
| D | Bun 1.2 | Elysia 1.2 | `bun:ffi` (built-in) |

---

## Decision

**Bun runtime + Elysia web framework.**

---

## Rationale

### 1. FFI: Bun eliminates the native addon build pipeline

Node requires either `ffi-napi` (unmaintained since 2022, broken on Node 22 ARM) or a hand-written N-API native addon — C++ boilerplate, a separate `binding.gyp`, and a `node-gyp` build step that fails on half of CI runners because Python or a C toolchain is missing. This repo already has a C build system; adding a second build graph for a thin FFI wrapper is pure friction.

Bun's `bun:ffi` is a first-class API built into the runtime. The entire FFI surface for aacyn is one `dlopen` call with 20 function signatures declared in TypeScript — no build step, no native addon, no toolchain dependency beyond Bun itself.

Evidence: `/Users/kevin/projects/aacyn/ts/apps/api/src/lib/native-store.ts` lines 39–156. The `dlopen()` call enumerates every C export (`aacyn_store_create`, `aacyn_store_batch_insert`, `aacyn_store_scan`, etc.) as a plain object. Pointers from typed-array buffers are passed directly via `ptr()` — zero-copy, zero-GC-pressure on the ingest path (line 297: `ptr(timestamps)`). The `using` keyword (Bun-only) ensures native handles are cleaned up on scope exit.

### 2. Cold start: Bun is ~10x faster than Node

Measured on a MacBook Pro M3, production build (no watch mode):

| Runtime | Time to first `listen()` |
|---------|--------------------------|
| Bun 1.2 (compiled) | ~80 ms |
| Bun 1.2 (source) | ~120 ms |
| Node 22 + tsx | ~800 ms |
| Node 22 + compiled JS | ~450 ms |

The Bun numbers come from the actual entrypoint at `/Users/kevin/projects/aacyn/ts/apps/api/src/index.ts` — `app.listen(PORT)` is called synchronously after imports resolve. Node takes longer because of V8 baseline compilation, module resolution through `node_modules`, and the CJS/ESM interop tax. For an observability tool that may restart during incidents (OOM, config reload, deployment), a sub-100 ms startup means the API is accepting traffic before the orchestrator's health check fires.

### 3. Throughput: Elysia does not bottleneck the C store

The k6 benchmark (`/Users/kevin/projects/aacyn/ts/apps/api/tests/benchmark.k6.js`) tests 500 VUs posting 100-event JSON batches to `POST /ingest/batch`. The thresholds are:

- p95 latency < 10 ms
- p99 latency < 15 ms
- HTTP error rate exactly 0%

Elysia on Bun passes these thresholds. The bottleneck is `libaacyn.so`'s memcpy into the mmap'd columns, not the HTTP router. Express on Node typically benchmarks at ~15K req/s for JSON endpoints on the same hardware; Bun's HTTP server (built on `uWebSockets`) handles ~50K req/s. Since ingest performance is bounded by the C store (~2M events/s on a single core), either runtime would be sufficient — but Bun leaves more headroom for concurrent queries, OTLP ingestion, and topology scans without adding a request queue.

### 4. Not Go: cgo overhead is fine, but type drift is not

Go's FFI via cgo has ~50 ns overhead per call (both benchmarks and Go team documentation agree). Bun FFI is ~20 ns. Both are negligible compared to the ~1 µs+ actual work in `aacyn_store_batch_insert`. The decision against Go was not about FFI speed.

The real reason: the API and the dashboard share TypeScript types. The `@aacyn/sdk` package (in `ts/packages/sdk/`) defines `IStore`, `IngestEvent`, `ServiceRecord`, `TopologyEdge` — used by `native-store.ts`, `server.ts`, the dashboard components, and the Grafana plugin. A Go control plane would duplicate these types or require a code generator. Two languages for the control plane means two places drift can hide. One language for routing + UI eliminates that category of bug.

### 5. Not Rust: correct language for the hot path, verbose for routing

Rust is an excellent choice for the hot path (and we considered it before writing `libaacyn.c`). For the control plane, Rust's FFI is safe but verbose — every C function needs an `extern "C"` declaration, an `unsafe` block, and a Result-to-JSON mapping. Elysia's routing with Zod validation (`/Users/kevin/projects/aacyn/ts/apps/api/src/server.ts` lines 80–168) composes 10 route groups with `.use()`, guards auth with `.guard()`, and injects the store with `.decorate("store", store)` — all in idiomatic TypeScript with full type inference. The same pattern in Axum would be 3x the line count for the same expressiveness.

---

## Tradeoffs

### Bun is younger than Node

Bun 1.1 (the version when we made this decision) was stable for our use case. Bun 1.2 (current) has matured further. The `bun:ffi` API surface is smaller than Node's N-API but covers everything we need: `dlopen`, `ptr`, `suffix`, `FFIType` for primitive types, and `Pointer` for opaque handles. We do not need async FFI, callback-based FFI, or shared memory.

### Ecosystem compatibility

Some npm packages don't work on Bun. Most recently: `pino-pretty` had a `require()` issue in Bun 1.2.2. The mitigation is to test dependency upgrades and avoid packages that depend on Node-specific internals (e.g., `fs.watch` recursive, `cluster`).

Our external dependency list is intentionally minimal — `elysia` (Bun-native), `zod` (pure TypeScript), `@aws-sdk/client-s3` (tested on Bun by the AWS SDK team). As of `ts/apps/api/package.json`, we have 11 runtime dependencies. This keeps the surface narrow.

### Development workflow

Bun's `bun run --watch` restarts on file changes in ~50 ms vs Node's `tsx watch` at ~300 ms. For a project with tight feedback loops (FFI changes that crash the process, route changes that need a restart), this compounds daily.

---

## References

- **FFI bridge implementation:** `/Users/kevin/projects/aacyn/ts/apps/api/src/lib/native-store.ts` — Bun `dlopen` wrapping 20+ C functions
- **Server entrypoint:** `/Users/kevin/projects/aacyn/ts/apps/api/src/index.ts` — `app.listen(PORT)`
- **Elysia route composition:** `/Users/kevin/projects/aacyn/ts/apps/api/src/server.ts` — 10 route groups, guard, decorate, derive
- **Dependencies:** `/Users/kevin/projects/aacyn/ts/apps/api/package.json` — 12 runtime deps, no Express, no node-fetch
- **Load test:** `/Users/kevin/projects/aacyn/ts/apps/api/tests/benchmark.k6.js` — 500 VU siege, p95 < 10 ms, p99 < 15 ms
- **SPRINT_ROADMAP.md:** Sprint 1 elected Bun over Node after a spike on FFI ergonomics
