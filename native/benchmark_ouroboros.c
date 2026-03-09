/*
 * benchmark_ouroboros.c — libaacyn Columnar Store Benchmark
 *
 * Measures three operations and reports throughput/latency:
 *   1. Ingest throughput  — batch insert N events
 *   2. Scan throughput    — full-table duration scan (SIMD max)
 *   3. Query latency      — error-only scan with time-range filter
 *
 * Build (from native/):
 *   cc -O3 -march=native -std=c17 -o ../build/benchmark_ouroboros \
 *       benchmark_ouroboros.c libaacyn.c
 *
 * Usage:
 *   ../build/benchmark_ouroboros              # 10M events (default)
 *   ../build/benchmark_ouroboros 5000000      # 5M events
 *   ../build/benchmark_ouroboros --quick      # 1M events (CI)
 *
 * Output: JSON to stdout.
 */

#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ─── Forward declarations from libaacyn.c ───────────────────────────────── */

typedef struct aacyn_store aacyn_store_t;

aacyn_store_t *aacyn_store_create(uint64_t capacity);
uint64_t       aacyn_store_batch_insert(aacyn_store_t *store,
                                        const uint64_t *timestamps,
                                        const float *durations,
                                        const uint8_t *is_errors,
                                        uint64_t count);
uint64_t       aacyn_store_len(const aacyn_store_t *store);
uint64_t       aacyn_store_capacity(const aacyn_store_t *store);
float          aacyn_store_scan_duration_max(const aacyn_store_t *store);
uint64_t       aacyn_store_scan_error_count(const aacyn_store_t *store);
void           aacyn_store_destroy(aacyn_store_t *store);

typedef struct __attribute__((packed)) {
  uint64_t timestamp;
  float    duration_ms;
  uint32_t is_error;
  uint32_t _padding;
} aacyn_scan_event_t;

uint64_t aacyn_store_scan(const aacyn_store_t *store,
                          uint64_t start_ns, uint64_t end_ns,
                          int32_t error_only, void *out_buf,
                          uint64_t out_cap);

/* ─── SIMD detection ────────────────────────────────────────────────────── */

static const char *simd_path(void) {
#if defined(__AVX512F__)
  return "AVX-512";
#elif defined(__AVX2__)
  return "AVX2";
#elif defined(__ARM_NEON)
  return "NEON";
#else
  return "scalar";
#endif
}

/* ─── Timing helper ──────────────────────────────────────────────────────── */

static double now_sec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
  uint64_t event_count = 10000000ULL; /* default 10M */

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--quick") == 0) {
      event_count = 1000000ULL;
    } else if (argv[i][0] != '-') {
      char *end;
      event_count = strtoull(argv[i], &end, 10);
      if (*end != '\0' || event_count == 0) {
        fprintf(stderr, "Usage: %s [count|--quick]\n", argv[0]);
        return 1;
      }
    }
  }

  fprintf(stderr, "[benchmark] Event count: %llu\n",
          (unsigned long long)event_count);
  fprintf(stderr, "[benchmark] SIMD path: %s\n", simd_path());

  /* ── Generate synthetic deterministic data ────────────────────────────── */

  uint64_t *timestamps = (uint64_t *)malloc(event_count * sizeof(uint64_t));
  float    *durations  = (float *)malloc(event_count * sizeof(float));
  uint8_t  *is_errors  = (uint8_t *)malloc(event_count * sizeof(uint8_t));

  if (!timestamps || !durations || !is_errors) {
    fprintf(stderr, "ERROR: malloc failed for synthetic data\n");
    free(timestamps); free(durations); free(is_errors);
    return 1;
  }

  for (uint64_t i = 0; i < event_count; i++) {
    /* 1 microsecond apart → 1M events span ~1 second wall clock */
    timestamps[i] = (uint64_t)i * 1000ULL;

    /* cycling pattern: 1.0, 1.5, 2.0, ..., 10.5, 1.0, ... */
    durations[i] = 1.0f + (float)(i % 20) * 0.5f;

    /* ~5.3% error rate (every 19th) */
    is_errors[i] = (i % 19 == 0) ? 1 : 0;
  }

  /* ── Create store ─────────────────────────────────────────────────────── */

  aacyn_store_t *store = aacyn_store_create(event_count);
  if (!store) {
    fprintf(stderr, "ERROR: aacyn_store_create failed\n");
    free(timestamps); free(durations); free(is_errors);
    return 1;
  }

  uint64_t cap = event_count; /* for JSON output */
  (void)cap;

  /* ────────────────────────────────────────────────────────────────────────
   *  BENCHMARK 1: Ingest throughput
   * ────────────────────────────────────────────────────────────────────── */

  double t0 = now_sec();
  uint64_t inserted = aacyn_store_batch_insert(store, timestamps,
                                                durations, is_errors,
                                                event_count);
  double t1 = now_sec();

  if (inserted != event_count) {
    fprintf(stderr, "WARN: inserted %llu / %llu events\n",
            (unsigned long long)inserted, (unsigned long long)event_count);
  }

  double ingest_time = t1 - t0;
  double ingest_rate = (double)inserted / ingest_time;

  fprintf(stderr, "[benchmark] Ingest: %.3f s → %.0f events/sec\n",
          ingest_time, ingest_rate);

  /* ────────────────────────────────────────────────────────────────────────
   *  BENCHMARK 2: Full-table scan (duration_max)
   * ────────────────────────────────────────────────────────────────────── */

  int scan_iters = 100;
  /* For small event counts, do more iterations for stable timing */
  if (event_count < 100000) scan_iters = 1000;

  t0 = now_sec();
  float max_dur = 0.0f;
  for (int i = 0; i < scan_iters; i++) {
    max_dur = aacyn_store_scan_duration_max(store);
  }
  t1 = now_sec();

  double scan_total = t1 - t0;
  double scan_avg_s = scan_total / (double)scan_iters;
  double scan_rate = (double)event_count / scan_avg_s;

  fprintf(stderr, "[benchmark] Scan (duration_max): %d iters, "
          "avg %.6f s/iter → %.0f events/sec  (result: %.2f)\n",
          scan_iters, scan_avg_s, scan_rate, max_dur);

  /* ────────────────────────────────────────────────────────────────────────
   *  BENCHMARK 3: Error query with time-range filter
   * ────────────────────────────────────────────────────────────────────── */

  /* Use a time range that covers all events so the scan iterates everything */
  uint64_t start_ns = timestamps[0];
  uint64_t end_ns   = timestamps[event_count - 1];

  aacyn_scan_event_t *out_buf =
      (aacyn_scan_event_t *)malloc(event_count * sizeof(aacyn_scan_event_t));
  if (!out_buf) {
    fprintf(stderr, "ERROR: malloc failed for query output buffer\n");
    aacyn_store_destroy(store);
    free(timestamps); free(durations); free(is_errors);
    return 1;
  }

  int query_iters = 100;
  if (event_count < 100000) query_iters = 1000;

  t0 = now_sec();
  uint64_t found = 0;
  for (int i = 0; i < query_iters; i++) {
    found = aacyn_store_scan(store, start_ns, end_ns, 1, out_buf,
                             event_count);
  }
  t1 = now_sec();

  double query_total = t1 - t0;
  double query_avg_s = query_total / (double)query_iters;
  double query_latency_ms = query_avg_s * 1000.0;

  fprintf(stderr, "[benchmark] Query (error scan): %d iters, "
          "avg %.6f s/iter → %.3f ms  (found %llu errors)\n",
          query_iters, query_avg_s, query_latency_ms,
          (unsigned long long)found);

  /* ── Output JSON ──────────────────────────────────────────────────────── */

  printf("{\n");
  printf("  \"libaacyn\": {\n");
  printf("    \"ingest_events_per_sec\": %.0f,\n", ingest_rate);
  printf("    \"scan_events_per_sec\": %.0f,\n", scan_rate);
  printf("    \"error_query_latency_ms\": %.6f,\n", query_latency_ms);
  printf("    \"events_inserted\": %llu\n",
         (unsigned long long)inserted);
  printf("  }\n");
  printf("}\n");

  /* ── Cleanup ──────────────────────────────────────────────────────────── */

  free(out_buf);
  aacyn_store_destroy(store);
  free(timestamps);
  free(durations);
  free(is_errors);

  return 0;
}
