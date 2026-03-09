/*
 * fuzz_ouroboros.c — Fuzz Harness for libaacyn Columnar Store
 *
 * Tests the core store API with randomized inputs to find crashes,
 * assertion failures, and memory safety violations.
 *
 * Run with ASan/UBSan for maximum coverage:
 *   make fuzz         # default 60s run
 *   make fuzz FUZZ_DURATION=120  # custom duration
 *
 * Requires: clang (for __has_feature(address_sanitizer) detection)
 *
 * Design:
 *   - Fixed seed for reproducibility
 *   - Random event generation (timestamps, durations, error flags)
 *   - Random batch sizes within remaining capacity
 *   - Random scan parameters (time ranges, error filters)
 *   - Edge-case injection (NaN durations, extreme timestamps)
 *   - Wrap-around stress via file-backed persistent store
 *   - Zero-capacity and NULL-param edge cases
 */

#define _GNU_SOURCE
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ─── Forward declarations from libaacyn.c ───────────────────────────────── */

typedef struct aacyn_store aacyn_store_t;

aacyn_store_t *aacyn_store_create(uint64_t capacity);
void           aacyn_store_destroy(aacyn_store_t *store);
aacyn_store_t *aacyn_store_open(const char *path, uint64_t capacity);
uint64_t       aacyn_store_batch_insert(aacyn_store_t *store,
                                        const uint64_t *timestamps,
                                        const float *durations,
                                        const uint8_t *is_errors,
                                        uint64_t count);
uint64_t       aacyn_store_len(const aacyn_store_t *store);
uint64_t       aacyn_store_capacity(const aacyn_store_t *store);
uint64_t       aacyn_store_head(const aacyn_store_t *store);
float          aacyn_store_scan_duration_max(const aacyn_store_t *store);
uint64_t       aacyn_store_scan_error_count(const aacyn_store_t *store);
void           aacyn_store_sync(aacyn_store_t *store);
uint64_t       aacyn_store_byte_size(const aacyn_store_t *store);
uint64_t       aacyn_store_get_events_dropped(const aacyn_store_t *store);

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

/* ─── Tiny PRNG (xorshift64) ─────────────────────────────────────────────── */

static uint64_t rng_state;

static uint64_t rng_next(void) {
  uint64_t x = rng_state;
  x ^= x << 13;
  x ^= x >> 7;
  x ^= x << 17;
  rng_state = x;
  return x;
}

static uint64_t rng_range(uint64_t lo, uint64_t hi) {
  if (hi <= lo)
    return lo;
  return lo + (rng_next() % (hi - lo));
}

static float rng_float(float lo, float hi) {
  double scale = (double)rng_next() / (double)UINT64_MAX;
  return (float)(lo + scale * (double)(hi - lo));
}

/* ─── Helper: fill arrays with random event data ─────────────────────────── */

static void fill_random_events(uint64_t *ts, float *dur, uint8_t *err,
                               uint64_t count) {
  for (uint64_t i = 0; i < count; i++) {
    ts[i] = rng_next();
    dur[i] = rng_float(0.0f, 5000.0f);
    err[i] = (uint8_t)(rng_next() & 0x01);
  }
}

/* ─── Fuzzing phases (anonymous stores, no wrap) ─────────────────────────── */

static int phase_empty_batch(aacyn_store_t *store) {
  uint64_t before = aacyn_store_len(store);
  uint64_t n = aacyn_store_batch_insert(store, NULL, NULL, NULL, 0);
  uint64_t after = aacyn_store_len(store);
  if (n != 0 || before != after) {
    fprintf(stderr, "FAIL: empty batch returned %llu (len %llu -> %llu)\n",
            (unsigned long long)n, (unsigned long long)before,
            (unsigned long long)after);
    return 1;
  }
  return 0;
}

static int phase_single_event(aacyn_store_t *store) {
  uint64_t cap = aacyn_store_capacity(store);
  if (aacyn_store_len(store) >= cap)
    return 0; /* skip if full */

  uint64_t ts = rng_next();
  float dur = rng_float(0.0f, 10000.0f);
  uint8_t err = (uint8_t)(rng_next() & 0x01);
  uint64_t n = aacyn_store_batch_insert(store, &ts, &dur, &err, 1);
  if (n != 1) {
    fprintf(stderr, "FAIL: single insert returned %llu\n",
            (unsigned long long)n);
    return 1;
  }
  return 0;
}

static int phase_random_batch(aacyn_store_t *store) {
  uint64_t cap = aacyn_store_capacity(store);
  uint64_t len = aacyn_store_len(store);
  if (len >= cap)
    return 0; /* skip if full */

  uint64_t remaining = cap - len;
  uint64_t count = rng_range(1, remaining > 100 ? 100 : remaining);
  uint64_t *ts = (uint64_t *)malloc(count * sizeof(uint64_t));
  float *dur = (float *)malloc(count * sizeof(float));
  uint8_t *err = (uint8_t *)malloc(count * sizeof(uint8_t));
  if (!ts || !dur || !err) {
    free(ts);
    free(dur);
    free(err);
    return 1;
  }

  fill_random_events(ts, dur, err, count);
  uint64_t n = aacyn_store_batch_insert(store, ts, dur, err, count);
  if (n != count) {
    fprintf(stderr, "FAIL: batch insert returned %llu (expected %llu)\n",
            (unsigned long long)n, (unsigned long long)count);
    free(ts);
    free(dur);
    free(err);
    return 1;
  }
  free(ts);
  free(dur);
  free(err);
  return 0;
}

static int phase_edge_values(aacyn_store_t *store) {
  uint64_t cap = aacyn_store_capacity(store);
  uint64_t len = aacyn_store_len(store);
  if (cap - len < 4)
    return 0; /* skip if not enough room */

  uint64_t ts[4] = {0, UINT64_MAX, 1000000, 0};
  float dur[4] = {NAN, INFINITY, -1.0f, 0.0f};
  uint8_t err[4] = {0, 1, 0xFF, 128};

  uint64_t n = aacyn_store_batch_insert(store, ts, dur, err, 4);
  if (n != 4) {
    fprintf(stderr, "FAIL: edge-case insert returned %llu\n",
            (unsigned long long)n);
    return 1;
  }
  return 0;
}

static int phase_random_scans(aacyn_store_t *store) {
  uint64_t len = aacyn_store_len(store);
  if (len == 0)
    return 0;

  /* Random scan parameters */
  uint64_t start_ns = rng_next();
  uint64_t end_ns = start_ns + rng_range(0, 1000000000);
  int32_t error_only = (int32_t)(rng_next() & 0x01);

  /* Buffer for scan results */
  uint64_t out_cap = 1024;
  aacyn_scan_event_t *buf =
      (aacyn_scan_event_t *)malloc(out_cap * sizeof(aacyn_scan_event_t));
  if (!buf)
    return 1;

  uint64_t found = aacyn_store_scan(store, start_ns, end_ns, error_only,
                                     buf, out_cap);
  if (found > out_cap) {
    fprintf(stderr, "FAIL: scan returned %llu > buffer capacity %llu\n",
            (unsigned long long)found, (unsigned long long)out_cap);
    free(buf);
    return 1;
  }

  /* Validate returned events */
  for (uint64_t i = 0; i < found; i++) {
    if (error_only && buf[i].is_error == 0) {
      fprintf(stderr, "FAIL: error_only scan returned non-error event\n");
      free(buf);
      return 1;
    }
  }

  free(buf);

  /* Also run the SIMD scans */
  float max_dur = aacyn_store_scan_duration_max(store);
  (void)max_dur; /* NaN/Inf from edge test is valid */

  uint64_t err_count = aacyn_store_scan_error_count(store);
  if (err_count > len) {
    fprintf(stderr, "FAIL: error count %llu > len %llu\n",
            (unsigned long long)err_count, (unsigned long long)len);
    return 1;
  }

  return 0;
}

static int phase_null_args(aacyn_store_t *store) {
  (void)store;
  /* These must not crash */
  aacyn_store_len(NULL);
  aacyn_store_capacity(NULL);
  aacyn_store_head(NULL);
  aacyn_store_byte_size(NULL);
  aacyn_store_scan_duration_max(NULL);
  aacyn_store_scan_error_count(NULL);
  aacyn_store_get_events_dropped(NULL);
  aacyn_store_sync(NULL);
  return 0;
}

static int phase_zero_capacity_store(void) {
  aacyn_store_t *zs = aacyn_store_create(0);
  if (!zs)
    return 0; /* NULL is acceptable for capacity=0 */

  uint64_t ts = 42;
  float dur = 1.0f;
  uint8_t err = 0;
  uint64_t n = aacyn_store_batch_insert(zs, &ts, &dur, &err, 1);
  if (n != 0) {
    fprintf(stderr,
            "FAIL: zero-capacity insert returned %llu (expected 0)\n",
            (unsigned long long)n);
    aacyn_store_destroy(zs);
    return 1;
  }

  aacyn_store_destroy(zs);
  return 0;
}

/* ─── Wrap-around phase (persistent, file-backed store) ──────────────────── */

static int phase_wrap_around(void) {
  const char *tmp_path = "/tmp/aacyn_fuzz_wrap_test.bin";
  uint64_t cap = rng_range(64, 1024);

  aacyn_store_t *store = aacyn_store_open(tmp_path, cap);
  if (!store) {
    fprintf(stderr, "FAIL: could not open persistent store for wrap test\n");
    return 1;
  }

  /* Insert exactly 2 full ring-buffer's worth. The persistent store
   * wraps via monotonic head, so the batch_insert may split a write
   * into two memcpy calls when count > tail_space. Each call reads
   * from the source at [inserted] up to [inserted + chunk], which is
   * always within our local buffer since chunk <= remaining_in_buffer. */
  uint64_t total_events = cap * 2;
  uint64_t buf_size = total_events + cap; /* generous padding for safety */
  uint64_t *ts = (uint64_t *)malloc(buf_size * sizeof(uint64_t));
  float *dur = (float *)malloc(buf_size * sizeof(float));
  uint8_t *err = (uint8_t *)malloc(buf_size * sizeof(uint8_t));
  if (!ts || !dur || !err) {
    free(ts);
    free(dur);
    free(err);
    aacyn_store_destroy(store);
    return 1;
  }

  fill_random_events(ts, dur, err, buf_size);

  /* Insert in varying batch sizes to exercise split-around logic */
  uint64_t inserted = 0;
  while (inserted < total_events) {
    uint64_t remaining = total_events - inserted;
    uint64_t max_chunk = rng_range(1, cap);
    uint64_t chunk = remaining < max_chunk ? remaining : max_chunk;

    uint64_t n = aacyn_store_batch_insert(store, ts + inserted,
                                           dur + inserted, err + inserted,
                                           chunk);
    if (n != chunk) {
      fprintf(stderr, "FAIL: wrap insert returned %llu (expected %llu)\n",
              (unsigned long long)n, (unsigned long long)chunk);
      free(ts);
      free(dur);
      free(err);
      aacyn_store_destroy(store);
      return 1;
    }
    inserted += chunk;
  }

  /* Verify head advanced past capacity */
  uint64_t head = aacyn_store_head(store);
  if (head < total_events) {
    fprintf(stderr, "FAIL: head %llu < total %llu after wrap\n",
            (unsigned long long)head, (unsigned long long)total_events);
    free(ts);
    free(dur);
    free(err);
    aacyn_store_destroy(store);
    return 1;
  }

  /* Verify scans still work on wrapped data */
  uint64_t scan_buf_cap = 256;
  aacyn_scan_event_t *sbuf =
      (aacyn_scan_event_t *)malloc(scan_buf_cap * sizeof(aacyn_scan_event_t));
  if (!sbuf) {
    free(ts);
    free(dur);
    free(err);
    aacyn_store_destroy(store);
    return 1;
  }

  uint64_t found = aacyn_store_scan(store, 0, UINT64_MAX, 0, sbuf, scan_buf_cap);
  if (found > scan_buf_cap) {
    fprintf(stderr, "FAIL: wrap scan returned %llu > buffer\n",
            (unsigned long long)found);
    free(ts);
    free(dur);
    free(err);
    free(sbuf);
    aacyn_store_destroy(store);
    return 1;
  }

  free(sbuf);
  free(ts);
  free(dur);
  free(err);
  aacyn_store_destroy(store);
  remove(tmp_path);
  return 0;
}

/* ─── Main: run phases in a loop for the given duration ──────────────────── */

int main(int argc, char *argv[]) {
  int duration_sec = 60;
  if (argc > 1)
    duration_sec = atoi(argv[1]);
  if (duration_sec < 1)
    duration_sec = 1;

  /* Use a fixed seed for reproducibility */
  rng_state = 0xAAC0DEADBEEF2024ULL;

  fprintf(stderr, "[fuzz] Starting fuzz harness -- %d seconds\n", duration_sec);

  /* Phase function table (anonymous store takes aacyn_store_t*) */
  typedef int (*anon_phase_fn)(aacyn_store_t *);
  anon_phase_fn anon_phases[] = {
      phase_empty_batch,
      phase_single_event,
      phase_random_batch,
      phase_edge_values,
      phase_random_scans,
      phase_null_args,
  };
  int num_anon_phases = sizeof(anon_phases) / sizeof(anon_phases[0]);

  /* Wrap-around phase is standalone (creates its own persistent store) */
  typedef int (*standalone_phase_fn)(void);
  standalone_phase_fn standalone_phases[] = {
      phase_zero_capacity_store,
      phase_wrap_around,
  };
  int num_standalone = sizeof(standalone_phases) / sizeof(standalone_phases[0]);

  time_t deadline = time(NULL) + duration_sec;
  uint64_t iterations = 0;
  uint64_t errors = 0;

  /* Run standalone phases once each before the timed loop */
  for (int i = 0; i < num_standalone; i++) {
    int rc = standalone_phases[i]();
    if (rc != 0) {
      fprintf(stderr, "[fuzz] FAIL: standalone phase %d\n", i);
      errors++;
    }
    iterations++;
  }

  while (time(NULL) < deadline) {
    /* Pick a random capacity for the anonymous store */
    uint64_t cap_values[] = {1, 8, 64, 128, 512, 1024, 4096, 65536};
    uint64_t cap = cap_values[rng_next() % (sizeof(cap_values) / sizeof(cap_values[0]))];

    aacyn_store_t *store = aacyn_store_create(cap);
    if (!store) {
      fprintf(stderr, "[fuzz] SKIP: store creation failed (cap=%llu)\n",
              (unsigned long long)cap);
      continue;
    }

    /* Run a random sequence of phases */
    int num_ops = (int)(rng_next() % 8) + 1;
    for (int i = 0; i < num_ops; i++) {
      int pi = (int)(rng_next() % num_anon_phases);
      int rc = anon_phases[pi](store);
      if (rc != 0) {
        fprintf(stderr, "[fuzz] FAIL: phase %d returned %d (iter=%llu)\n",
                pi, rc, (unsigned long long)iterations);
        errors++;
        if (errors >= 100) {
          fprintf(stderr, "[fuzz] TOO MANY ERRORS -- aborting early\n");
          aacyn_store_destroy(store);
          goto done;
        }
        break; /* continue to next store */
      }
      iterations++;
    }

    aacyn_store_destroy(store);
  }

done:
  fprintf(stderr, "[fuzz] Done -- %llu iterations, %llu errors\n",
          (unsigned long long)iterations, (unsigned long long)errors);

  if (errors > 0) {
    fprintf(stderr, "[fuzz] FAILED: %llu errors detected\n",
            (unsigned long long)errors);
    return 1;
  }

  fprintf(stderr, "[fuzz] PASSED: %llu iterations, 0 errors\n",
          (unsigned long long)iterations);
  return 0;
}
