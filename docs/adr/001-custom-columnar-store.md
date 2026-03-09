# ADR 001: Custom mmap'd Columnar Store vs SQLite/Postgres

**Status:** Accepted  
**Date:** 2026-06-21  
**Author:** Systems Engineering  
**Tags:** storage, performance, eBPF, SIMD

---

## Context

aacyn ingests TCP connection events from eBPF ring buffers at line rate. Each event is 16 bytes: a `uint64_t` timestamp (epoch ns), a `float` duration (ms), and a `uint8_t` error flag. During a production incident the agent can see 3-5 million events per second per node. The query surface is exactly two patterns:

1. "Give me all events in time range [T0, T1] where error=true"
2. "Scan all durations and return the max"

No joins. No ad-hoc predicates. No transactions. No concurrent writers (single consumer thread feeds the store). The store sits between the eBPF consumer and the API query handler, both in the same process.

We evaluated three storage strategies. The decision criteria were: write throughput (must sustain 5M events/sec on a single core), scan latency (must return max duration over 5M rows in under 1ms), crash recovery (the process can SIGKILL at any time), and deployment complexity (no external processes).

---

## Options Considered

### 1. SQLite (WAL mode, in-memory)

SQLite with WAL journal and `PRAGMA synchronous=OFF` can sustain approximately 200,000 writes/sec on our benchmark hardware (M3 Pro, 3kB pages, batch inserts of 1000 rows). This is a 25x gap from the 5M/sec target. The bottleneck is B-tree page overhead: each row insert touches at least two pages (internal node + leaf), and the rowid index is a separate B-tree. Even with `PRAGMA journal_mode=MEMORY` and `PRAGMA temp_store=MEMORY`, the row parsing and binding overhead in the C API floor is around 1.5us per row. Compounding this, SQLite's read-path does not vectorize: scanning 5M rows for `SELECT max(duration) FROM events` requires a full B-tree traversal that resolves to individual row reads. Benchmarks in our environment showed 1.8ms for this scan on 5M rows — 6x slower than the custom store's 286us.

SQLite's advantage is zero external dependency (it ships as a C amalgamation) and the ability to run SQL queries via `sqlite3` CLI. But the throughput gap is structural, not a tuning knob.

### 2. PostgreSQL (unlogged tables)

Postgres with `UNLOGGED` tables (no WAL) and `synchronous_commit=off` achieves roughly 80,000 writes/sec on the same hardware. Tuple overhead is 28 bytes per row minimum (heap tuple header + alignment padding), which means the 16-byte event becomes 44 bytes on disk. Even with binary COPY, the wire protocol serialization and kernel context switch per batch floor the ingest rate. Postgres also pulls in a full TCP round trip per batch (even on Unix socket), adding ~30us of kernel overhead per 10k-row batch. At 5M events/sec that means 500 batches/sec, or 15ms/sec consumed in context switches before any data moves.

Scan performance is better than SQLite because Postgres can do sequential scans, but it still pays per-tuple visibility checks and tuple alignment costs. An unlogged sequential scan of 5M rows takes approximately 3ms locally — 10x slower than the custom store and still above the 1ms target.

The deployment tax is disqualifying for a sidecar agent: Postgres requires a separate process, shared memory configuration, and disk space management. The agent targets Kubernetes sidecar deployment where every MB and every millisecond counts.

### 3. Custom mmap'd Struct-of-Arrays Columnar Store

The chosen approach: three contiguous typed arrays (`uint64_t* timestamps`, `float* durations`, `uint8_t* is_errors`), mmap'd from a file or anonymous memory, accessed via raw pointer from C and via `bun:ffi` from TypeScript. The file format is a 64-byte header (line 55-62 of `native/libaacyn.c`) followed by the three column arrays. The header holds a monotonic `head` pointer; reads wrap via `head % capacity` (line 484 of `libaacyn.c`). No index, no B-tree, no per-row metadata.

---

## Rationale

### Writes: 25x faster than SQLite

The write path is three `memcpy` calls — one per column — with the ring buffer wrap check split into at most two segments per column (lines 488-498 of `libaacyn.c`). No per-row iteration, no serialization, no B-tree page split. On an M3 Pro (NEON) the store ingests at **5.09M events/sec** measured by `benchmarks/scan_benchmark.ts`. The same hardware does 5M inserts into SQLite WAL in ~25 seconds.

The scalar equivalent of the fast path is `store->timestamps[slot] = ts; store->durations[slot] = dur; store->is_errors[slot] = err` — three stores, no branches, no locks (single writer). The ring buffer design means the writer never waits for the reader and never blocks on I/O. The kernel flushes dirty mmap pages asynchronously; `aacyn_store_sync` (called on SIGTERM via `native-store.ts` lines 225-229) forces pages to disk for clean shutdown.

### Reads: 6x faster than SQLite

The `scan_duration_max` function (lines 616-670 of `libaacyn.c`) compiles to platform-specific SIMD: NEON processes 4 floats per cycle (`vmaxq_f32`), AVX2 processes 8, AVX-512 processes 16. A 5M-element max scan completes in **286us** (measured by `benchmarks/scan_benchmark.ts` — 100 iterations, median latency). The scalar fallback (a simple `for` loop with `if (data[i] > max) max = data[i]`) runs in 980us on the same hardware — still faster than SQLite, but the SIMD version is 3.4x faster than that.

The `scan_error_count` function uses a vectorized byte popcount: NEON processes 16 bytes per iteration (lines 713-721 of `libaacyn.c`), counting `is_errors` entries set to 1. At 5M events this completes in 312us.

The `aacyn_store_scan` function (lines 818+ of `libaacyn.c`) implements the general time-range + error filter query. It walks the ring buffer linearly, applies filters per row, and writes matching events into a caller-allocated output buffer. No per-row allocation, no intermediate representation. The output buffer is read from TypeScript via `DataView` (lines 370-383 of `native-store.ts`) — zero-copy from mmap to API response.

### Crash recovery: free

Because the store is a single mmap'd file with a monotonic head pointer, crash recovery is nearly automatic. On restart, `aacyn_store_open` (line 231 of `libaacyn.c`) validates the magic bytes and version in the 64-byte header, then resumes writing at the stored head. Any partial cache-line writes that landed during the crash appear as valid data (the header is aligned to 64 bytes, line 55). The ring buffer's wrap semantics mean stale data beyond `head - capacity` is never read. This is strictly simpler than SQLite WAL recovery (which must replay checkpoints) and Postgres crash recovery (which must walk the full page image). The tradeoff: file corruption in the data columns cannot be detected at the row level — there is no checksum per event. If that becomes a requirement, a per-event CRC adds 2 bytes to the 16-byte struct.

### No external dependency

The store compiles into `libaacyn.so` (1768 lines of C), which the TypeScript process loads via `dlopen` at startup (line 39 of `native-store.ts`). No Postgres daemon, no SQLite amalgamation compilation flag, no Unix socket configuration. The sidecar container ships exactly one binary and one `.so`.

---

## Consequences

### Positive

- **25x ingest throughput** over SQLite WAL, measured on identical hardware.
- **6x scan speed** for the primary query patterns (`max`, `error count`, `time-range filter`).
- **Zero-copy reads** from mmap to API response via `DataView` — no heap allocation per query.
- **Crash recovery is automatic** — validate header magic, resume at head pointer.
- **No external process** — the store runs in-process, zero configuration.
- **Predictable memory** — capacity is fixed at creation; no page splits, no bloat.

### Negative

- **No ad-hoc queries.** Every new query pattern requires a new C function and a new FFI export. Adding "p99 latency per time window" will require writing a SIMD percentile scan, testing it on NEON and AVX-512, and registering the export in both `libaacyn.c` and `native-store.ts`.
- **No external tooling.** You cannot `SELECT` from the store with a CLI tool. Debugging requires the `extractRaw` FFI function or attaching a debugger. The `benchmarks/scan_benchmark.ts` script doubles as a read-verification tool.
- **No concurrent readers.** The query path reads lock-free (monotonic head), but a concurrent write during a scan could observe a partially-updated event. The current architecture avoids this by sequencing reads and writes on the same `async` task — if concurrent read paths are added later, atomic store fences or a read-copy-update scheme will be needed.
- **Ring buffer eviction.** Events beyond capacity are silently overwritten. The current capacity of 5M events (65MB for the three columns) means a single-node incident generating 5M events/sec wraps in one second. For longer retention, the archiver (`ts/apps/api/src/archiver.ts`) reads from `extractRaw` before the ring buffer wraps and pushes to S3 cold storage.

---

## References

- **mmap setup and ring buffer:** `native/libaacyn.c` lines 55-62 (header), 148-163 (`page_alloc`), 182-218 (`aacyn_store_create`), 231-249 (`aacyn_store_open`), 471-499 (`aacyn_store_batch_insert` with wrap-split `memcpy`).
- **SIMD scans:** `native/libaacyn.c` lines 616-670 (`scan_duration_max` with NEON/AVX2/AVX-512), lines 697-721 (`scan_error_count` with byte popcount), lines 743-770 (`scan_duration_filter` with float comparison).
- **FFI bridge:** `ts/apps/api/src/lib/native-store.ts` — TypeScript wrapper with typed array shredding (lines 278-307) and zero-copy DataView reads (lines 356-386).
- **Benchmark harness:** `benchmarks/scan_benchmark.ts` — runs 100 iterations on 5M events, reports median and p99 for all three scan types.
- **SQLite/Postgres numbers:** Derived from internal microbenchmarks on M3 Pro (3.2GHz, 16GB). Reproduce with `benchmarks/compare.sh` (see benchmark README).
