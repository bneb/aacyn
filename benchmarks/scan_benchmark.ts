/**
 * Query Scan Benchmark — AVX-512 Vectorized Reads
 *
 * Fills the native columnar store with N events, then measures:
 *   1. scan_duration_max  (SIMD horizontal max)
 *   2. scan_error_count   (SIMD byte popcount)
 *   3. scan_duration_filter (SIMD threshold compare)
 *
 * Usage:
 *   bun run benchmarks/scan_benchmark.ts [count]
 *   bun run benchmarks/scan_benchmark.ts 5000000
 */

import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi";
import { join, dirname } from "path";

// ── Load native library ───────────────────────────────────────────────────────
const LIB_PATH = join(
    dirname(__dirname),
    "build",
    `libaacyn.${suffix}`
);

const { symbols } = dlopen(LIB_PATH, {
    aacyn_store_create: {
        args: [FFIType.u64],
        returns: FFIType.ptr,
    },
    aacyn_store_batch_insert: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.u64,
    },
    aacyn_store_len: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_byte_size: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_scan_duration_max: {
        args: [FFIType.ptr],
        returns: FFIType.f32,
    },
    aacyn_store_scan_error_count: {
        args: [FFIType.ptr],
        returns: FFIType.u64,
    },
    aacyn_store_scan_duration_filter: {
        args: [FFIType.ptr, FFIType.f32],
        returns: FFIType.u64,
    },
    aacyn_store_destroy: {
        args: [FFIType.ptr],
        returns: FFIType.void,
    },
});

// ── Configuration ─────────────────────────────────────────────────────────────
const EVENT_COUNT = parseInt(process.argv[2] || "5000000", 10);
const WARMUP_ITERS = 5;
const BENCH_ITERS = 100;

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  🔬 Query Scan Benchmark                                ║`);
console.log(`╠══════════════════════════════════════════════════════════╣`);
console.log(`║  Events:     ${EVENT_COUNT.toLocaleString().padEnd(42)}║`);
console.log(`║  Warmup:     ${WARMUP_ITERS} iterations${" ".repeat(31)}║`);
console.log(`║  Benchmark:  ${BENCH_ITERS} iterations${" ".repeat(30)}║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

// ── Create & Fill Store ───────────────────────────────────────────────────────
console.log("⏳ Creating native store...");
const store = symbols.aacyn_store_create(EVENT_COUNT) as Pointer;
if (!store) throw new Error("Failed to create store");

console.log("⏳ Generating synthetic events...");
const BATCH = 100_000;
const batches = Math.ceil(EVENT_COUNT / BATCH);

for (let b = 0; b < batches; b++) {
    const count = Math.min(BATCH, EVENT_COUNT - b * BATCH);
    const timestamps = new BigUint64Array(count);
    const durations = new Float32Array(count);
    const isErrors = new Uint8Array(count);

    const baseTime = BigInt(Date.now() * 1_000_000); // ns
    for (let i = 0; i < count; i++) {
        timestamps[i] = baseTime + BigInt(b * BATCH + i) * 1000n;
        durations[i] = 2.0 + Math.random() * 8.0; // 2-10ms range
        isErrors[i] = Math.random() > 0.95 ? 1 : 0; // ~5% error rate

        // Occasional spike
        if (Math.random() > 0.999) {
            durations[i] = 50.0 + Math.random() * 100.0;
        }
    }

    symbols.aacyn_store_batch_insert(
        store,
        ptr(timestamps),
        ptr(durations),
        ptr(isErrors),
        count,
    );
}

const storeLen = Number(symbols.aacyn_store_len(store));
const storeMB = (Number(symbols.aacyn_store_byte_size(store)) / 1024 / 1024).toFixed(1);
console.log(`✅ Store populated: ${storeLen.toLocaleString()} events (${storeMB}MB)\n`);

// ── Benchmark Function ────────────────────────────────────────────────────────
function bench(name: string, fn: () => unknown): { median: number; p99: number; result: unknown } {
    // Warmup
    for (let i = 0; i < WARMUP_ITERS; i++) fn();

    // Benchmark
    const timings: number[] = [];
    let lastResult: unknown;
    for (let i = 0; i < BENCH_ITERS; i++) {
        const start = Bun.nanoseconds();
        lastResult = fn();
        const end = Bun.nanoseconds();
        timings.push((end - start) / 1_000); // → microseconds
    }

    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    const p99 = timings[Math.floor(timings.length * 0.99)];

    return { median, p99, result: lastResult };
}

// ── Run Benchmarks ────────────────────────────────────────────────────────────
console.log("── Scan Benchmarks ──────────────────────────────────────\n");

const maxScan = bench("scan_duration_max", () =>
    symbols.aacyn_store_scan_duration_max(store),
);

const errScan = bench("scan_error_count", () =>
    symbols.aacyn_store_scan_error_count(store),
);

const filterScan = bench("scan_duration_filter(>10ms)", () =>
    symbols.aacyn_store_scan_duration_filter(store, 10.0),
);

// ── Results ───────────────────────────────────────────────────────────────────
const eventsPerSecMax = Math.round(EVENT_COUNT / (maxScan.median / 1_000_000));
const eventsPerSecErr = Math.round(EVENT_COUNT / (errScan.median / 1_000_000));
const eventsPerSecFilter = Math.round(EVENT_COUNT / (filterScan.median / 1_000_000));

console.log(`  scan_duration_max`);
console.log(`    Result:   ${(maxScan.result as number).toFixed(2)}ms`);
console.log(`    Median:   ${maxScan.median.toFixed(0)}μs`);
console.log(`    p99:      ${maxScan.p99.toFixed(0)}μs`);
console.log(`    Rate:     ${eventsPerSecMax.toLocaleString()} scanned events/sec\n`);

console.log(`  scan_error_count`);
console.log(`    Result:   ${Number(errScan.result).toLocaleString()} errors`);
console.log(`    Median:   ${errScan.median.toFixed(0)}μs`);
console.log(`    p99:      ${errScan.p99.toFixed(0)}μs`);
console.log(`    Rate:     ${eventsPerSecErr.toLocaleString()} scanned events/sec\n`);

console.log(`  scan_duration_filter (>10ms)`);
console.log(`    Result:   ${Number(filterScan.result).toLocaleString()} matches`);
console.log(`    Median:   ${filterScan.median.toFixed(0)}μs`);
console.log(`    p99:      ${filterScan.p99.toFixed(0)}μs`);
console.log(`    Rate:     ${eventsPerSecFilter.toLocaleString()} scanned events/sec\n`);

console.log("── Summary ─────────────────────────────────────────────\n");
console.log(`  ${storeLen.toLocaleString()} events · ${storeMB}MB columnar data`);
console.log(`  scan_duration_max:    ${maxScan.median.toFixed(0)}μs (${(maxScan.median / 1000).toFixed(2)}ms)`);
console.log(`  scan_error_count:     ${errScan.median.toFixed(0)}μs (${(errScan.median / 1000).toFixed(2)}ms)`);
console.log(`  scan_duration_filter: ${filterScan.median.toFixed(0)}μs (${(filterScan.median / 1000).toFixed(2)}ms)`);
console.log(`\n  All scans complete in < ${Math.max(maxScan.p99, errScan.p99, filterScan.p99).toFixed(0)}μs p99\n`);

// ── Cleanup ───────────────────────────────────────────────────────────────────
symbols.aacyn_store_destroy(store);
