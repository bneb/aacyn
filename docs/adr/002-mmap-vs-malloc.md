# ADR 002: mmap with MAP_ANON vs malloc for the ring buffer

## Context

The event store is a ring buffer that can hold 10 million events (160 MB for the three
SoA columns: 80 MB for `uint64_t[]` timestamps, 40 MB for `float[]` durations, 10 MB
for `uint8_t[]` is_errors, plus a 64-byte header). This memory is the primary data
plane: the C engine writes to it on every eBPF ring buffer drain (thousands of events
per second), and the TypeScript API reads from it on every query, dashboard refresh,
and topology computation.

Three non-negotiable requirements drove the allocation strategy:

1. **Crash survival.** The process (C engine + Bun runtime) may be killed by OOM,
   SIGKILL, or node failure. On restart, unread events must still be available.
   Losing the head pointer means losing the cursor into unprocessed data.
2. **Zero-copy FFI access.** Typed arrays passed through Bun FFI must read column
   data at native memory addresses, not through a serialization layer. Every
   serialization round-trip at 10M events costs seconds.
3. **Cross-platform.** The allocation strategy must work identically on macOS
   (development, ARM64) and Linux (production, x86_64).

## Options

### malloc / aligned_alloc

The simplest path. `aligned_alloc(page_size, bytes)` gives page-aligned memory that
any function in the same process can use. The initial implementation had a
`malloc_then_free` fallback path.

**Fatal problems:**
- Heap memory dies with the process. Crash recovery is impossible without an
  external serializer (write-ahead log, checkpoint file) that adds latency and
  complexity on every `append()`.
- Bun FFI can read malloc'd pointers via `ptr()` — the address is valid within the
  process. But there is no mechanism to share heap memory across a fork() or to
  survive an exec(). A crash loses everything.
- No built-in msync. To persist, the engine would need to memcpy into a file on
  every batch — a 160 MB copy at tens of thousands of events per second destroys
  the tail latency budget.

Verdict: malloc cannot satisfy crash survival without an expensive external
persistence layer bolted on top.

### mmap with MAP_PRIVATE | MAP_ANONYMOUS

Anonymous `mmap` with copy-on-write semantics. Used by `page_alloc()` in
`libaacyn.c` for the columnar buffers.

**Advantages over malloc:**
- Pages are backed by swap. Under memory pressure, the kernel evicts pages instead
  of OOM-killing the process.
- Page-aligned by construction (the kernel maps at page granularity). No need for
  `aligned_alloc` fallback — though `page_alloc` retains the fallback for platforms
  that reject mmap flags.
- Pointer stability: same virtual address for the lifetime of the mapping. The C
  engine holds `store->timestamps`, Bun FFI holds the return value of
  `symbols.aacyn_store_create()`. Both point to the same physical pages — no copy,
  no serialization.

**Limitation:** MAP_PRIVATE pages do not survive process death. Crash recovery
still requires a file-backed approach. This is acceptable for the anonymous store
created by `aacyn_store_create()` (used in tests and single-run contexts), but not
for production.

### mmap with MAP_SHARED (file-backed)

Used by `aacyn_store_open()` for persistent stores. The entire store file is
`mmap`'d with `MAP_SHARED`:

```c
mmap(NULL, total_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
```

**Why MAP_SHARED over MAP_PRIVATE for persistence:**
- Every write by the C engine is visible to the kernel page cache immediately.
  Other processes (or a restarted instance) that `mmap` the same file with
  `MAP_SHARED` see the latest data via cache coherence.
- `msync()` flushes dirty pages to disk in a single syscall. No need to track
  individual dirty regions — the kernel tracks dirty pages at the page level.
- Crash recovery: on restart, `aacyn_store_open()` validates the 64-byte header
  (magic bytes `0x4141434E "AACN"`, version, capacity), reads `head` and `count`,
  and resumes. Events written before the crash but not yet `msync`'d may be lost,
  but the store is never corrupted — the kernel flushes a consistent snapshot.

**Why not MAP_PRIVATE on the file:**
MAP_PRIVATE on a file descriptor creates a CoW copy of the file's pages. Writes
go to private pages, never back to the file. Crash survival is defeated — the
file stays at its last `msync` (or never written if no msync happened). The entire
point of the file-backed store is persistence, so MAP_SHARED is the only correct
choice.

### POSIX shared memory (shm_open)

`shm_open` creates a file descriptor in a tmpfs-backed namespace. Semantically
similar to `MAP_SHARED | MAP_ANONYMOUS` with a name. Rejected because:

- `shm_open` paths must be globally unique on the host. A monitoring agent running
  multiple instances (sidecar per node) would need to coordinate names — collisions
  cause silent corruption.
- No file on disk means no crash recovery across a full node reboot (tmpfs is
  wiped). The persistent store needs real files for cross-reboot survival.
- macOS implements `shm_open` with `MAP_ANON` semantics, but the name uniqueness
  problem remains.

## Decision

**Use mmap for all ring buffer allocations.** Two paths:

| Use case | Flags | File backing | Function |
|----------|-------|-------------|----------|
| Anonymous (tests, ephemeral) | `MAP_PRIVATE \| MAP_ANONYMOUS` | None | `page_alloc()` → `aacyn_store_create()` |
| Persistent (production) | `MAP_SHARED` | `$DATA_DIR/store.aacyn` | `aacyn_store_open()` |

The C engine's `aacyn_store_t` struct tracks whether each column was mmap'd or
`aligned_alloc`'d (via the `ts_is_mmap`, `dur_is_mmap`, `err_is_mmap` flags) so
that `page_free()` can dispatch to `munmap()` or `free()` correctly.

## Rationale

### Anonymous path: MAP_PRIVATE | MAP_ANONYMOUS

This is the "fast path" — no I/O, no file descriptor. Bun FFI and the C engine
share the same process, so MAP_PRIVATE is sufficient: writes by the C engine
are immediately visible to any pointer within the same virtual address space
(no copy-on-write divergence within a single process). The `mmap` is over kill:
`aligned_alloc` would work for the same-process case. But using the same
allocation primitive (`mmap`) for both paths keeps the deallocation logic
uniform and avoids maintaining two allocation backends.

### Persistent path: MAP_SHARED with file

`MAP_SHARED` is required so that kernel page cache writes are visible to future
process instances. The store file acts as a write-ahead log with O(1) recovery:
validate the header, compute column offsets from the base pointer, and resume.

Crash recovery workflow:
1. Process starts, calls `aacyn_store_open("store.aacyn", 10_000_000)`.
2. `open(O_RDWR | O_CREAT)`, `fstat()` to check file size.
3. If new: `ftruncate()` to pre-allocate, `memset` header with magic + version + capacity.
4. If existing: validate magic (`0x4141434E`) and version (`1`). Read `header->head` and
   `header->count`. Compute column pointers as offsets from mmap base.
5. Resume ingestion at `head`. Events before `head` are still in the ring buffer —
   queried by subtracting from `head` within capacity bounds.

### macOS compatibility: MAP_ANON

macOS defines `MAP_ANON` as the primary constant (`0x1000`), with `MAP_ANONYMOUS`
as a macro alias (`#define MAP_ANONYMOUS MAP_ANON`). On Linux, `MAP_ANONYMOUS` is
the primary name (`0x20`), and `MAP_ANON` is defined as `MAP_ANONYMOUS`. The code
uses `MAP_ANONYMOUS` (the POSIX-standardized name) which works on both platforms.
The `page_alloc` fallback to `aligned_alloc` catches any platform where `mmap`
with `MAP_ANONYMOUS` fails.

### Page size divergence

`page_align()` calls `getpagesize()` at runtime:
- macOS ARM64: 16 KB pages.
- Linux x86_64: 4 KB pages.

The ring buffer wraparound logic uses modulo (`% capacity`), not bitmask, so page
size differences do not affect correctness. However, the mmap size is always
rounded up to the nearest page boundary (`page_align(total_size)`). On macOS this
means ~16 KB of overhead per column vs ~4 KB on Linux — negligible at 160 MB.

## Tradeoffs

- **Fixed capacity.** Neither mmap path supports resizing. The capacity is chosen
  at construction and baked into the file size / mmap region. We allocate 200 MB
  upfront (160 MB data + ~40 MB slop for page alignment and header). For a
  monitoring tool that runs on dedicated hardware (3-5% of 8 GB+ node memory),
  this is acceptable.
- **msync cost.** `aacyn_store_sync()` calls `msync(MS_SYNC)` on the entire 160 MB
  region. On a busy node this takes 50-200 ms. We call it only on SIGTERM and on
  explicit archive triggers — not on every append.
- **SIGBUS risk.** If the disk fills up and the file cannot be extended, `mmap`'d
  pages past the file's extent cause SIGBUS. Mitigated by pre-allocating the full
  file size with `ftruncate()` (macOS) or `fallocate()` (Linux) at open time.
- **No cross-process concurrency.** The current architecture is single-process
  (C engine + Bun runtime in one process). MAP_SHARED would support
  multiple readers via fork(), but we do not use this today. The IPC overhead
  of coordinating a shared head pointer is not worth the complexity.

## References

- `native/libaacyn.c` lines 135-137: `page_align()` — runtime page size lookup.
- `native/libaacyn.c` lines 148-163: `page_alloc()` — `MAP_PRIVATE | MAP_ANONYMOUS`
  mmap with `aligned_alloc` fallback.
- `native/libaacyn.c` lines 165-172: `page_free()` — dispatches to `munmap` or
  `free` based on the `is_mmap` flag.
- `native/libaacyn.c` lines 182-218: `aacyn_store_create()` — anonymous store
  creation, calls `page_alloc` per column.
- `native/libaacyn.c` lines 226-360: `aacyn_store_open()` — persistent store with
  file-backed `MAP_SHARED` mmap, header validation, column offset computation.
- `native/libaacyn.c` lines 604-607: `aacyn_store_sync()` — `msync(MS_SYNC)`.
- `native/libaacyn.c` lines 1830-1853: `aacyn_store_destroy()` — `munmap` of
  mmap_base and `page_free` of each column.
- `ts/apps/api/src/lib/native-store.ts` lines 39-52: Bun FFI `dlopen` — exports
  `aacyn_store_create` and `aacyn_store_open` as native functions returning
  FFI `ptr`.
- `ts/apps/api/src/lib/native-store.ts` lines 199-248: `NativeStore` class —
  constructor selects persistent or anonymous path.
- `ts/apps/api/src/lib/native-store.ts` lines 271-277: `ingestBatch()` — zero-copy
  via typed array backing buffers passed as FFI pointers.
