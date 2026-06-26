---
path: native/**/*.c, native/**/*.h
---

# C Engine Rules (libaacyn)

## Architecture
- `libaacyn.c` (1,679 lines) — the hot path. mmap'd Struct-of-Arrays columnar store.
- Three columns: `uint64_t timestamps[]`, `float durations[]`, `uint8_t is_errors[]`.
- Ring buffer with monotonic head pointer, wraps at capacity via modulo.
- SIMD scans: AVX-512 (x86_64), NEON (ARM64), scalar fallback.
- eBPF consumer via libbpf ring buffer polling (`#ifdef AACYN_HAS_LIBBPF`).
- Hand-rolled FlatBuffer parser (no library dependency) — 16-byte event structs.
- License validation with 7-day grace period.

## Build System
- `native/Makefile` — platform auto-detection (macOS vs Linux, x86 vs ARM).
- `EBPF=1` flag to compile with libbpf (Linux only).
- `make sanitize` for ASan/UBSan builds.
- `make test` compiles and runs `test_ouroboros.c` (14 tests).

## Quality Constraints
- Every function ≤ 32 lines. The current 1,679-line file is acceptable as a single translation unit but new logic should be extracted into separate functions.
- Every pointer dereference MUST have a preceding NULL check.
- Every `malloc`/`mmap` must have a corresponding `free`/`munmap` path.
- All `memcpy` calls must have verified bounds — source size known, destination capacity checked.
- SIMD paths must have a scalar fallback that runs on platforms without AVX-512/NEON.
- eBPF code paths are behind `#ifdef AACYN_HAS_LIBBPF` — never break the non-eBPF build.
- License checks in C must match the TypeScript implementation in `heartbeat.ts` exactly.
- Ring buffer arithmetic must handle wraparound correctly — test with exact capacity alignment.
- New functions must be declared in `libaacyn.h` (to be created in Sprint 5) to keep the FFI surface documented.

## Testing
- `test_ouroboros.c` covers: ring buffer append/read, wrap-around, crash recovery, SIMD scans, filter rules.
- Run with `make test` before every commit that touches C code.
- Run with `make sanitize` to catch memory errors.
- Fuzz the FlatBuffer parser with random bytes — any crash is a bug.
- Test on both macOS (NEON) and Linux (AVX-512) before merging.

## Common Pitfalls
- `getpagesize()` needs `<unistd.h>` — missing include causes harmless warning on some platforms.
- GCC left-to-right symbol resolution: `LDLIBS` (`-lbpf -lelf -lz`) must come AFTER the source file.
- mmap MAP_ANONYMOUS vs MAP_ANON: use `MAP_ANON` for macOS compatibility.
- Ring buffer modulo with `capacity` that isn't a power of 2: use `%` not `&`.
- eBPF: `vmlinux.h` doesn't include socket constants — define `AF_INET 2` explicitly.
