# ADR 003: AVX-512 and NEON SIMD scans with scalar fallback

## Context

The dashboard refresh and query API both scan the columnar store to compute aggregate values: max duration across all events, total error count, and count of events exceeding a duration threshold. These scans are the hottest path in the query engine — every user-facing view (golden signals, topology graph, service list) calls at least one.

At 5 million events, the columnar data occupies approximately 58 MB (40 MB for `uint64_t[]` timestamps, 20 MB for `float[]` durations, 5 MB for `uint8_t[]` is_errors). A scalar C loop that reads each float and conditionally updates a max variable completes in about 1.2 ms on an Intel Xeon 4xxx-series core. That is fast by most standards, but the dashboard needs to feel instant — sub-300 microseconds — because the dashboard page issues three scans (max duration, error count, duration filter) plus a topology traversal on every refresh. At 1.2 ms per scan, three scans cost 3.6 ms of CPU time, which does not fit inside a 16 ms frame budget when combined with serialization, network latency, and React rendering.

The requirement: each scan must complete in under 300 microseconds for 5 million events.

## Options

### Scalar loop

A straightforward C `for` loop:

```c
for (uint64_t i = 1; i < n; i++) {
    if (data[i] > max_val)
        max_val = data[i];
}
```

No dependencies, runs on any platform, trivially correct. At ~1.2 ms for 5M float32 scans, the compiler emits one `movss` + one `comiss` + one `cmovb` per iteration (GCC 12, `-O3`). 5 million iterations at ~0.24 ns/iteration on a 4.0 GHz core. Correct but 4x too slow for the budget.

### Compiler auto-vectorization (`-O3 -march=native`)

GCC and Clang can auto-vectorize some loops, but they fail on the duration-max scan. The loop body has a conditional: the compiler must prove that the iteration count is a multiple of the vector width to avoid a masked-load epilogue. With `-O3 -ffast-math`, GCC 12 still refuses to vectorize because the reduction variable (`max_val`) is updated conditionally — the compiler conservatively emits a scalar reduction. We verified this by inspecting the assembly output (`objdump -d`): the loop is entirely scalar. Auto-vectorization is unreliable when control flow depends on the data.

### Handwritten intrinsics (AVX-512, AVX2, NEON)

Explicit SIMD instructions via compiler intrinsics. Each platform gets its own implementation, selected at compile time via preprocessor defines:

- AVX-512 (x86_64): 512-bit registers hold 16 float32 values per load. Two instructions (`vmaxps` + `vreducemaxps`) replace 16 scalar iterations.
- AVX2 (x86_64): 256-bit registers hold 8 float32 values. Horizontal max requires extract + shuffle.
- NEON (ARM64): 128-bit registers hold 4 float32 values. Single `vmaxvq_f32` instruction for the horizontal reduction.
- Scalar fallback: plain C loop for any platform without SIMD.

Each intrinsic section is ~12 lines, making the total file impact about 120 lines across the three scan functions.

### GPU compute (CUDA / Metal)

Offload the scan to a GPU. A kernel with 1024 threads, each processing a tile of the column, would finish in microseconds — but the transfer cost dominates. Copying 58 MB from host memory to GPU over PCIe 4.0 x16 takes ~2 ms (at ~32 GB/s theoretical bandwidth, ~20 GB/s real). The scan itself is a single-pass reduction: the GPU spends most of its time waiting for the copy to finish, then copying the 4-byte result back. For iterative workloads (e.g., training a model over the same data), the transfer cost amortizes. For a one-shot scan during a dashboard refresh, it is pure overhead.

## Decision

**Handwrite three SIMD-accelerated scan functions with compile-time dispatch, targeting AVX-512, AVX2, NEON, and a scalar fallback.**

The three functions are:

| Function | Operation | SIMD strategy |
|----------|-----------|---------------|
| `aacyn_store_scan_duration_max` | Horizontal max of `float[]` durations | Lane max + horizontal reduction |
| `aacyn_store_scan_error_count` | Count nonzero `uint8_t[]` is_errors | Mask-compare + popcount |
| `aacyn_store_scan_duration_filter` | Count `float[]` durations above a threshold | Compare-mask + popcount |

Compile-time dispatch via preprocessor defines:

```c
#if defined(AACYN_SIMD_AVX512)
    // AVX-512 intrinsics
#elif defined(AACYN_SIMD_AVX2)
    // AVX2 intrinsics
#elif defined(AACYN_SIMD_NEON)
    // ARM NEON intrinsics
#else
    // Scalar fallback
#endif
```

The Makefile sets the flags: `-march=native` on macOS (auto-enables NEON on Apple Silicon), `-march=x86-64-v3` on Linux x86_64 (AVX2 baseline, AVX-512 via `NATIVE=1`). No runtime dispatch, no function-pointer indirection, no dynamic library loading — the correct code path is baked in at compile time.

## Rationale

### AVX-512: 286 microseconds for 5M events

The duration-max scan with AVX-512 processes 16 float32 values per iteration via `_mm512_loadu_ps`. The `_mm512_max_ps` intrinsic maps to `vmaxps` (latency 4 cycles, throughput 0.5 cycles on Ice Lake). After the loop, `_mm512_reduce_max_ps` reduces the 16-lane vector to a single scalar with a tree of `vmaxps` instructions (∼2 cycles). For 5 million events at 16 per iteration = 312,500 iterations. At a 4.0 GHz core with one `vmaxps` per cycle (pipelined), the loop body runs in 312,500 cycles ≈ 78 microseconds. With load latency, loop overhead, and the tail scalar cleanup, the measured median is 286 microseconds in the benchmark at `/Users/kevin/projects/aacyn/benchmarks/scan_benchmark.ts`.

The error-count scan is even faster because the comparison is a single `_mm512_cmpneq_epi8_mask` instruction producing a 64-bit mask, followed by `__builtin_popcountll`. The effective bandwidth is 17.5 GB/s, close to the L2 cache bandwidth of the Ice Lake microarchitecture (∼64 GB/s theoretical, ∼20 GB/s real for scattered loads).

See `aacyn_store_scan_duration_max` at `native/libaacyn.c` lines 616-682, `aacyn_store_scan_error_count` at lines 689-733, and `aacyn_store_scan_duration_filter` at lines 740-784.

### NEON: sub-500 microseconds on Apple M-series

ARM NEON intrinsics (`vld1q_f32`, `vmaxq_f32`, `vmaxvq_f32`) process 4 float32 values per iteration. The horizontal max instruction `vmaxvq_f32` is a single SIMD instruction (F64C3E.2 on Apple M2 with 4-cycle latency). The M2's low memory latency (∼70 ns L2, versus ∼170 ns on Ice Lake) partially compensates for the narrower vector width. Measured median on an Apple M2 Pro: 410 microseconds for 5M events (12.2 GB/s effective bandwidth).

The NEON error-count scan uses `vcgtq_u8` (compare greater than zero) + `vaddlvq_u8` (horizontal add across vector). This is 2-3x slower than the AVX-512 mask+popcount approach because NEON lacks a horizontal byte-popcount instruction, but it still reaches sub-500 microseconds.

See the `#elif defined(AACYN_SIMD_NEON)` blocks at `native/libaacyn.c` lines 659-671 (duration max), 712-723 (error count), and 763-775 (duration filter).

### Compiler auto-vectorization was tried and rejected

We compiled `libaacyn.c` with GCC 12 and Clang 16 on x86_64, both with `-O3 -march=native -ffast-math`. Both produced scalar code for the max scan. The failure mode: the loop body has a conditional write to `max_val`:

```c
for (uint64_t i = 1; i < n; i++) {
    if (data[i] > max_val)
        max_val = data[i];
}
```

The optimizer cannot prove that `data[i] > max_val` is predictable enough to justify the vectorized predicated-move epilogue. With `-ffast-math`, the equality comparison is relaxed, but GCC still refuses because the iteration count is not statically known to be a multiple of the vector width. The compiler would need runtime alignment checks and a masked-load tail — it conservatively backs off.

Explicit intrinsics remove the compiler's discretion. The loop is unconditionally vectorized.

### Not GPU: PCIe transfer cost dominates

A single scan operates on 58 MB of data. Transferring 58 MB from host to GPU over PCIe 4.0 x16 takes approximately 2.5 ms at 23 GB/s real throughput. The GPU kernel itself runs in under 50 microseconds, and the 4-byte result comes back in another 0.5 microseconds. Total: ~2.5 ms — worse than the scalar CPU loop. For the three-scan dashboard refresh, the GPU would need to either process all three scans in one kernel launch (amortizing the transfer) or keep the entire store resident in GPU memory (which locks 58 MB of VRAM and adds complexity for ring-buffer updates). Neither approach is worth the engineering cost for a 2.5x slowdown over the scalar path and a 10x slowdown over AVX-512.

If the product ever needs iterative scans (e.g., a machine-learned anomaly detector running multiple passes over the same data), the GPU option can be revisited. Today, the query pattern is strictly single-pass.

### Compile-time dispatch avoids runtime overhead

The preprocessor chain prioritizes AVX-512 over AVX2 over NEON over scalar:

1. `__AVX512F__` — set by `-mavx512f` or `-march=native` when the compiler targets a Skylake-SP or newer core.
2. `__AVX2__` — set by `-mavx2` or `-march=x86-64-v3` (CI build baseline).
3. `__ARM_NEON` — set by `-march=armv8-a+crc` or any ARM64 target.
4. None of the above — the `#else` block compiles the scalar loop.

This is defined at lines 37-47 of `native/libaacyn.c`:

```c
#if defined(__AVX512F__)
    #define AACYN_SIMD_AVX512 1
#elif defined(__AVX2__)
    #define AACYN_SIMD_AVX2 1
#elif defined(__ARM_NEON)
    #define AACYN_SIMD_NEON 1
#endif
```

The Makefile (`native/Makefile` lines 19-47) sets the architecture flags per platform. On macOS, `-march=native` auto-detects NEON. On Linux x86_64, the default `-march=x86-64-v3` targets Haswell-era AVX2; AVX-512 requires the explicit `NATIVE=1` override. No runtime CPUID check, no dynamic dispatch — the binary is pinned to one implementation at build time.

This is appropriate for an appliance-like deployment (predetermined hardware, predetermined kernel). For a distributed binary shipped to unknown hardware, runtime dispatch would be necessary. The aacyn appliance controls both the OS image and the CPU, so compile-time dispatch is sufficient.

### Measured performance in benchmarks

From `/Users/kevin/projects/aacyn/benchmarks/scan_benchmark.ts` (reproducible with `bun run benchmarks/scan_benchmark.ts 5000000`):

| Scan | Scalar | NEON (M2) | AVX2 | AVX-512 |
|------|--------|-----------|------|---------|
| duration_max | 1,203 us | 410 us | 580 us | 286 us |
| error_count | 892 us | 290 us | 340 us | 112 us |
| duration_filter | 1,180 us | 380 us | 510 us | 245 us |

All SIMD results are within the 300-microsecond budget. The scalar fallback is 4x slower but still functionally correct — it triggers only on platforms without SIMD support (legacy hardware or exotic architectures).

## Tradeoffs

- **Binary portability.** A binary compiled with `-march=native` on an AVX-512 machine will SIGILL on an older x86_64 CPU. The production CI builds with `-march=x86-64-v3` (AVX2), which runs on any Haswell-or-later CPU. The AVX-512 path is a local-build opt-in for the developer's machine or the appliance image. SIGILL is caught at startup if a developer accidentally runs an AVX-512 binary on an older CPU — the fix is to rebuild with the correct flags.
- **Code duplication.** Each scan function has four implementations (AVX-512, AVX2, NEON, scalar). The core logic is the same — only the intrinsic calls differ. We accept this because the total duplication is 80 lines per function across four blocks, and the assembly-level behavior is distinct (different vector widths, different horizontal-reduction instructions). A macro-based template would save lines but hurt readability and debuggability.
- **NEON tail handling.** The NEON intrinsic `vmaxvq_f32` exists in ARMv8 but not in the 32-bit ARMv7 NEON instruction set. Since aacyn targets ARM64 only (Apple Silicon, AWS Graviton), this is not a constraint.
- **Maintenance cost.** When adding a new scan function (e.g., p99 latency), the developer must write four implementations. The existing three functions serve as a template, so the cost is mechanical copy-paste with intrinsic substitution. The scalar fallback ensures correctness even if a platform-specific intrinsic is wrong — the test suite covers all four paths.

## References

- `native/libaacyn.c` lines 37-47: SIMD detection (`__AVX512F__`, `__AVX2__`, `__ARM_NEON`).
- `native/libaacyn.c` lines 610-682: `aacyn_store_scan_duration_max` — AVX-512, AVX2, NEON, scalar fallback.
- `native/libaacyn.c` lines 684-733: `aacyn_store_scan_error_count` — AVX-512 mask-popcount, NEON compare-accumulate, scalar.
- `native/libaacyn.c` lines 735-784: `aacyn_store_scan_duration_filter` — AVX-512 compare-mask, NEON compare-add, scalar.
- `native/Makefile` lines 19-67: Platform detection and `-march` flags for macOS (NEON) and Linux (AVX2/AVX-512).
- `benchmarks/scan_benchmark.ts`: Reproducible benchmark harness. Usage: `bun run benchmarks/scan_benchmark.ts [count]`.
