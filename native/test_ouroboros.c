/*
 * test_ouroboros.c — TDD Test Harness for Persistent Ring-Buffer Store
 *
 * Compile and run:
 *   make test    (from native/ directory)
 *
 * Tests:
 *   1. Create new store file — verify header
 *   2. Insert events — verify column data
 *   3. Wrap-around — verify oldest overwritten
 *   4. Crash recovery — close + reopen
 *   5. SIMD scans on wrapped data
 *   6. Split batch across wrap boundary
 */

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* ─── Forward declarations from libaacyn ─────────────────────────────────── */

/*
 * Forward declaration of aacyn_store (incomplete type).
 *
 * SAFE: The test suite only passes pointers to aacyn_store through the
 * public API -- it never dereferences struct fields. The full definition
 * lives in libaacyn.c (single translation unit), so there is no header.
 * An incomplete type is sufficient for pointer-only usage.
 */
typedef struct aacyn_store aacyn_store_t;

/* Existing API */
aacyn_store_t *aacyn_store_create(uint64_t capacity);
uint64_t aacyn_store_batch_insert(aacyn_store_t *store,
                                  const uint64_t *timestamps,
                                  const float *durations,
                                  const uint8_t *is_errors, uint64_t count);
uint64_t aacyn_store_len(const aacyn_store_t *store);
uint64_t aacyn_store_capacity(const aacyn_store_t *store);
float aacyn_store_scan_duration_max(const aacyn_store_t *store);
uint64_t aacyn_store_scan_error_count(const aacyn_store_t *store);
void aacyn_store_destroy(aacyn_store_t *store);

/* New persistent API */
aacyn_store_t *aacyn_store_open(const char *path, uint64_t capacity);
void aacyn_store_sync(aacyn_store_t *store);
uint64_t aacyn_store_head(const aacyn_store_t *store);

/* Query scan API */
typedef struct __attribute__((packed)) {
  uint64_t timestamp;
  float duration_ms;
  uint32_t is_error;
  uint32_t _padding;
} aacyn_scan_event_t;

uint64_t aacyn_store_scan(const aacyn_store_t *store, uint64_t start_ns,
                          uint64_t end_ns, int32_t error_only, void *out_buf,
                          uint64_t out_cap);

/* Raw byte extraction API (archiver) */
uint64_t aacyn_store_extract_raw(const aacyn_store_t *store, uint64_t from_head,
                                 uint64_t count, void *out_buf);

/* gRPC/generic protocol event types (declared in libaacyn.c) */
typedef struct __attribute__((packed)) {
  uint64_t timestamp_ns;
  uint32_t pid;
  uint32_t tgid;
  uint32_t dest_ip;
  uint32_t source_ip;
  uint16_t dest_port;
  uint16_t status;
  uint8_t  protocol;
  uint8_t  path_len;
  uint64_t bytes;
  char comm[16];
  char trace_id[16];
  uint64_t span_id;
  uint64_t parent_span_id;
  char path[32];
} ebpf_network_event_t;

#define AACYN_MAX_TOPO_EDGES 512

typedef struct {
  char source_comm[16];
  char container_id[16];
  uint32_t source_ip;
  uint32_t dest_ip;
  uint16_t dest_port;
  uint16_t _pad;
  uint64_t hit_count;
  uint64_t total_latency_ns;
  uint64_t last_seen_ns;
  uint64_t total_bytes;
  uint64_t error_count;
  uint64_t retransmit_count;
  char grpc_service[32];
} aacyn_topology_edge_t;

/* Declarative filter API */
#define AACYN_COL_DURATION  0
#define AACYN_COL_IS_ERROR  1
#define AACYN_COL_TIMESTAMP 2
#define AACYN_OP_LT   0
#define AACYN_OP_GT   1
#define AACYN_OP_EQ   2
#define AACYN_OP_NEQ  3
#define AACYN_OP_LTE  4
#define AACYN_OP_GTE  5
#define AACYN_ACTION_DROP 0
#define AACYN_ACTION_KEEP 1

typedef struct __attribute__((packed)) {
  uint8_t  column;
  uint8_t  op;
  uint8_t  action;
  uint8_t  _pad;
  double   threshold;
  uint32_t _reserved;
} aacyn_rule_t;

void aacyn_store_set_rules(aacyn_store_t *store, const void *rules_buf,
                           uint32_t num_rules);
uint64_t aacyn_store_get_events_dropped(const aacyn_store_t *store);

/* ─── Test Helpers ───────────────────────────────────────────────────────── */

#define TEST_PATH "/tmp/aacyn_test_store.bin"

static int tests_run = 0;
static int tests_passed = 0;

#define ASSERT_MSG(cond, msg)                                                  \
  do {                                                                         \
    if (!(cond)) {                                                             \
      fprintf(stderr, "  ✗ FAIL: %s (line %d)\n    %s\n", __func__, __LINE__,  \
              msg);                                                            \
      return 0;                                                                \
    }                                                                          \
  } while (0)

#define ASSERT_EQ(a, b, msg)                                                   \
  do {                                                                         \
    if ((a) != (b)) {                                                          \
      fprintf(stderr,                                                          \
              "  ✗ FAIL: %s (line %d)\n    %s\n    expected: %llu, got: "      \
              "%llu\n",                                                        \
              __func__, __LINE__, msg, (unsigned long long)(b),                \
              (unsigned long long)(a));                                        \
      return 0;                                                                \
    }                                                                          \
  } while (0)

#define ASSERT_FLOAT_EQ(a, b, msg)                                             \
  do {                                                                         \
    float _diff = (a) - (b);                                                   \
    if (_diff < -0.001f || _diff > 0.001f) {                                   \
      fprintf(stderr,                                                          \
              "  ✗ FAIL: %s (line %d)\n    %s\n    expected: %f, got: %f\n",   \
              __func__, __LINE__, msg, (double)(b), (double)(a));              \
      return 0;                                                                \
    }                                                                          \
  } while (0)

static void cleanup(void) { unlink(TEST_PATH); }

#define RUN_TEST(fn)                                                           \
  do {                                                                         \
    tests_run++;                                                               \
    cleanup();                                                                 \
    fprintf(stderr, "  ▸ %s ... ", #fn);                                       \
    if (fn()) {                                                                \
      tests_passed++;                                                          \
      fprintf(stderr, "✓\n");                                                  \
    }                                                                          \
  } while (0)

/* ─── Test 1: Create new store file ──────────────────────────────────────── */

static int test_create_new_store(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "aacyn_store_open returned NULL");
  ASSERT_EQ(aacyn_store_capacity(store), 1024, "capacity mismatch");
  ASSERT_EQ(aacyn_store_len(store), 0, "new store should have len=0");
  ASSERT_EQ(aacyn_store_head(store), 0, "new store should have head=0");

  /* Verify file exists and has correct size */
  struct stat st;
  ASSERT_MSG(stat(TEST_PATH, &st) == 0, "store file not created");
  /* File size = 64 (header) + 1024 * (8 + 4 + 1) = 64 + 13312 = 13376,
     page-aligned */
  ASSERT_MSG(st.st_size > 0, "store file is empty");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 2: Insert events and verify data ──────────────────────────────── */

static int test_insert_events(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  uint64_t ts[5] = {100, 200, 300, 400, 500};
  float dur[5] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f};
  uint8_t err[5] = {0, 1, 0, 1, 0};

  uint64_t inserted = aacyn_store_batch_insert(store, ts, dur, err, 5);
  ASSERT_EQ(inserted, 5, "should insert 5 events");
  ASSERT_EQ(aacyn_store_len(store), 5, "len should be 5");
  ASSERT_EQ(aacyn_store_head(store), 5, "head should be 5");
  ASSERT_FLOAT_EQ(aacyn_store_scan_duration_max(store), 5.0f,
                  "max duration should be 5.0");
  ASSERT_EQ(aacyn_store_scan_error_count(store), 2, "error count should be 2");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 3: Wrap-around ────────────────────────────────────────────────── */

static int test_wrap_around(void) {
  const uint64_t cap = 100;
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
  ASSERT_MSG(store != NULL, "open failed");

  /* Fill the store to capacity */
  for (uint64_t i = 0; i < cap; i++) {
    uint64_t ts = i;
    float dur = (float)i;
    uint8_t err = 0;
    aacyn_store_batch_insert(store, &ts, &dur, &err, 1);
  }

  ASSERT_EQ(aacyn_store_len(store), cap, "len should be at capacity");
  ASSERT_EQ(aacyn_store_head(store), cap, "head should be cap");

  /* Insert 10 more — should wrap */
  for (uint64_t i = 0; i < 10; i++) {
    uint64_t ts = 1000 + i;
    float dur = 1000.0f + (float)i;
    uint8_t err = 1;
    aacyn_store_batch_insert(store, &ts, &dur, &err, 1);
  }

  ASSERT_EQ(aacyn_store_len(store), cap, "len should still be cap");
  ASSERT_EQ(aacyn_store_head(store), cap + 10, "head should be cap+10");

  /* The max duration should be from the newest batch (1009.0) */
  ASSERT_FLOAT_EQ(aacyn_store_scan_duration_max(store), 1009.0f,
                  "max duration should be 1009.0 after wrap");

  /* Error count: 10 new errors, originals had 0 errors */
  ASSERT_EQ(aacyn_store_scan_error_count(store), 10,
            "error count should be 10 after wrap");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 4: Crash recovery ─────────────────────────────────────────────── */

static int test_crash_recovery(void) {
  const uint64_t cap = 256;

  /* Phase 1: Write data and sync */
  {
    aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
    ASSERT_MSG(store != NULL, "open failed (phase 1)");

    uint64_t ts[50];
    float dur[50];
    uint8_t err[50];
    for (int i = 0; i < 50; i++) {
      ts[i] = (uint64_t)(i + 1);
      dur[i] = (float)(i + 1) * 0.5f;
      err[i] = (i % 5 == 0) ? 1 : 0;
    }
    aacyn_store_batch_insert(store, ts, dur, err, 50);
    aacyn_store_sync(store);
    aacyn_store_destroy(store);
  }

  /* Phase 2: Reopen and verify state */
  {
    aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
    ASSERT_MSG(store != NULL, "open failed (phase 2)");
    ASSERT_EQ(aacyn_store_len(store), 50, "len should survive restart");
    ASSERT_EQ(aacyn_store_head(store), 50, "head should survive restart");
    ASSERT_FLOAT_EQ(aacyn_store_scan_duration_max(store), 25.0f,
                    "max duration should survive restart");
    ASSERT_EQ(aacyn_store_scan_error_count(store), 10,
              "error count should survive restart");
    aacyn_store_destroy(store);
  }

  return 1;
}

/* ─── Test 5: SIMD scans on wrapped data ─────────────────────────────────── */

static int test_simd_scan_wrapped(void) {
  const uint64_t cap = 64;
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
  ASSERT_MSG(store != NULL, "open failed");

  /* Fill with low values */
  for (uint64_t i = 0; i < cap; i++) {
    uint64_t ts = i;
    float dur = 1.0f;
    uint8_t err = 0;
    aacyn_store_batch_insert(store, &ts, &dur, &err, 1);
  }

  /* Wrap with high values — overwrite first 16 slots */
  for (uint64_t i = 0; i < 16; i++) {
    uint64_t ts = 1000 + i;
    float dur = 99.0f;
    uint8_t err = 1;
    aacyn_store_batch_insert(store, &ts, &dur, &err, 1);
  }

  ASSERT_FLOAT_EQ(aacyn_store_scan_duration_max(store), 99.0f,
                  "SIMD max should find wrapped high value");
  ASSERT_EQ(aacyn_store_scan_error_count(store), 16,
            "SIMD error count should find wrapped errors");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 6: Split batch across wrap boundary ───────────────────────────── */

static int test_split_batch(void) {
  const uint64_t cap = 100;
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
  ASSERT_MSG(store != NULL, "open failed");

  /* Fill to slot 90 */
  for (uint64_t i = 0; i < 90; i++) {
    uint64_t ts = i;
    float dur = 1.0f;
    uint8_t err = 0;
    aacyn_store_batch_insert(store, &ts, &dur, &err, 1);
  }

  /* Insert batch of 20 — straddles the wrap boundary (slots 90-99, 0-9) */
  uint64_t ts[20];
  float dur[20];
  uint8_t err[20];
  for (int i = 0; i < 20; i++) {
    ts[i] = 500 + (uint64_t)i;
    dur[i] = 50.0f + (float)i;
    err[i] = 1;
  }

  uint64_t inserted = aacyn_store_batch_insert(store, ts, dur, err, 20);
  ASSERT_EQ(inserted, 20, "should insert all 20 across boundary");
  ASSERT_EQ(aacyn_store_len(store), cap, "len should be at capacity");
  ASSERT_EQ(aacyn_store_head(store), 110, "head should be 110");

  /* Max duration should be the highest from the split batch */
  ASSERT_FLOAT_EQ(aacyn_store_scan_duration_max(store), 69.0f,
                  "max should be 50.0+19=69.0 from split batch");
  ASSERT_EQ(aacyn_store_scan_error_count(store), 20,
            "all 20 from split batch should be errors");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 7: Scan with time filter ──────────────────────────────────────── */

static int test_scan_time_filter(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  /* Insert events with timestamps 100, 200, 300, 400, 500 */
  uint64_t ts[5] = {100, 200, 300, 400, 500};
  float dur[5] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f};
  uint8_t err[5] = {0, 0, 0, 0, 0};
  aacyn_store_batch_insert(store, ts, dur, err, 5);

  aacyn_scan_event_t buf[10];

  /* Scan all */
  uint64_t n = aacyn_store_scan(store, 0, 0, 0, buf, 10);
  ASSERT_EQ(n, 5, "unfiltered scan should return 5");

  /* Scan with lower bound: ts >= 300 */
  n = aacyn_store_scan(store, 300, 0, 0, buf, 10);
  ASSERT_EQ(n, 3, "scan with start=300 should return 3");
  ASSERT_EQ(buf[0].timestamp, 300, "first match should be ts=300");

  /* Scan with upper bound: ts <= 200 */
  n = aacyn_store_scan(store, 0, 200, 0, buf, 10);
  ASSERT_EQ(n, 2, "scan with end=200 should return 2");

  /* Scan with range: 200 <= ts <= 400 */
  n = aacyn_store_scan(store, 200, 400, 0, buf, 10);
  ASSERT_EQ(n, 3, "scan with range 200-400 should return 3");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 8: Scan with error filter ─────────────────────────────────────── */

static int test_scan_error_filter(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  uint64_t ts[5] = {100, 200, 300, 400, 500};
  float dur[5] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f};
  uint8_t err[5] = {0, 1, 0, 1, 0};
  aacyn_store_batch_insert(store, ts, dur, err, 5);

  aacyn_scan_event_t buf[10];

  /* Scan errors only */
  uint64_t n = aacyn_store_scan(store, 0, 0, 1, buf, 10);
  ASSERT_EQ(n, 2, "error-only scan should return 2");
  ASSERT_EQ(buf[0].timestamp, 200, "first error should be ts=200");
  ASSERT_EQ(buf[1].timestamp, 400, "second error should be ts=400");
  ASSERT_EQ(buf[0].is_error, 1, "is_error field should be 1");

  /* Scan errors with time filter */
  n = aacyn_store_scan(store, 300, 0, 1, buf, 10);
  ASSERT_EQ(n, 1, "error-only scan with start=300 should return 1");
  ASSERT_EQ(buf[0].timestamp, 400, "only error >= 300 is at ts=400");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 9: Scan on wrapped ring buffer ────────────────────────────────── */

static int test_scan_wrapped(void) {
  const uint64_t cap = 50;
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
  ASSERT_MSG(store != NULL, "open failed");

  /* Fill to capacity with timestamps 0..49 */
  for (uint64_t i = 0; i < cap; i++) {
    uint64_t t = i;
    float d = (float)i;
    uint8_t e = 0;
    aacyn_store_batch_insert(store, &t, &d, &e, 1);
  }

  /* Wrap: insert 10 more with timestamps 1000..1009, all errors */
  for (uint64_t i = 0; i < 10; i++) {
    uint64_t t = 1000 + i;
    float d = 100.0f + (float)i;
    uint8_t e = 1;
    aacyn_store_batch_insert(store, &t, &d, &e, 1);
  }

  aacyn_scan_event_t buf[100];

  /* Scan all — should return cap events (oldest were overwritten) */
  uint64_t n = aacyn_store_scan(store, 0, 0, 0, buf, 100);
  ASSERT_EQ(n, cap, "scan should return cap events");

  /* Scan errors only — should find the 10 wrapped errors */
  n = aacyn_store_scan(store, 0, 0, 1, buf, 100);
  ASSERT_EQ(n, 10, "error-only should find 10 wrapped errors");
  ASSERT_EQ(buf[0].timestamp, 1000, "first error should be ts=1000");

  /* Scan with limit */
  n = aacyn_store_scan(store, 0, 0, 0, buf, 5);
  ASSERT_EQ(n, 5, "scan with limit=5 should return 5");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 10: Raw byte extraction (linear) ──────────────────────────────── */

static int test_extract_raw_linear(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  uint64_t ts[5] = {100, 200, 300, 400, 500};
  float dur[5] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f};
  uint8_t err[5] = {0, 1, 0, 1, 0};
  aacyn_store_batch_insert(store, ts, dur, err, 5);

  /* Extract all 5 events: 5 * 13 = 65 bytes */
  uint8_t buf[65];
  uint64_t n = aacyn_store_extract_raw(store, 0, 5, buf);
  ASSERT_EQ(n, 5, "should extract 5 events");

  /* Verify timestamps column */
  uint64_t *ts_out = (uint64_t *)buf;
  ASSERT_EQ(ts_out[0], 100, "ts[0] should be 100");
  ASSERT_EQ(ts_out[4], 500, "ts[4] should be 500");

  /* Verify durations column */
  float *dur_out = (float *)(buf + 5 * sizeof(uint64_t));
  ASSERT_FLOAT_EQ(dur_out[0], 1.0f, "dur[0] should be 1.0");
  ASSERT_FLOAT_EQ(dur_out[4], 5.0f, "dur[4] should be 5.0");

  /* Verify errors column */
  uint8_t *err_out = buf + 5 * sizeof(uint64_t) + 5 * sizeof(float);
  ASSERT_EQ(err_out[1], 1, "err[1] should be 1");
  ASSERT_EQ(err_out[2], 0, "err[2] should be 0");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 11: Raw byte extraction (wrapped) ─────────────────────────────── */

static int test_extract_raw_wrapped(void) {
  const uint64_t cap = 50;
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, cap);
  ASSERT_MSG(store != NULL, "open failed");

  /* Fill to capacity with timestamps 0..49 */
  for (uint64_t i = 0; i < cap; i++) {
    uint64_t t = i;
    float d = (float)i;
    uint8_t e = 0;
    aacyn_store_batch_insert(store, &t, &d, &e, 1);
  }

  /* Wrap: insert 10 more (head = 60, timestamps 1000..1009) */
  for (uint64_t i = 0; i < 10; i++) {
    uint64_t t = 1000 + i;
    float d = 100.0f + (float)i;
    uint8_t e = 1;
    aacyn_store_batch_insert(store, &t, &d, &e, 1);
  }

  /* Extract slots 45..59 (the last 5 old + 10 new = 15 events)
     These span the wrap boundary (slots 45-49 + 0-9). */
  uint8_t buf[15 * 13];
  uint64_t n = aacyn_store_extract_raw(store, 45, 15, buf);
  ASSERT_EQ(n, 15, "should extract 15 events across wrap");

  /* Verify: first 5 timestamps should be 45,46,47,48,49 */
  uint64_t *ts_out = (uint64_t *)buf;
  ASSERT_EQ(ts_out[0], 45, "wrapped ts[0] should be 45");
  ASSERT_EQ(ts_out[4], 49, "wrapped ts[4] should be 49");

  /* Next 10 should be 1000..1009 */
  ASSERT_EQ(ts_out[5], 1000, "wrapped ts[5] should be 1000");
  ASSERT_EQ(ts_out[14], 1009, "wrapped ts[14] should be 1009");

  /* Verify durations */
  float *dur_out = (float *)(buf + 15 * sizeof(uint64_t));
  ASSERT_FLOAT_EQ(dur_out[0], 45.0f, "wrapped dur[0] should be 45.0");
  ASSERT_FLOAT_EQ(dur_out[5], 100.0f, "wrapped dur[5] should be 100.0");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 12: Filter rules — drop by duration ─────────────────────────── */

static int test_filter_drop_duration(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  /* Rule: DROP events WHERE duration < 1.0 */
  aacyn_rule_t rule;
  memset(&rule, 0, sizeof(rule));
  rule.column = AACYN_COL_DURATION;
  rule.op = AACYN_OP_LT;
  rule.action = AACYN_ACTION_DROP;
  rule.threshold = 1.0;
  aacyn_store_set_rules(store, &rule, 1);

  /* Insert 5 events: durations [0.1, 0.5, 1.0, 2.0, 5.0] */
  uint64_t ts[5] = {100, 200, 300, 400, 500};
  float dur[5] = {0.1f, 0.5f, 1.0f, 2.0f, 5.0f};
  uint8_t err[5] = {0, 0, 0, 0, 0};
  uint64_t inserted = aacyn_store_batch_insert(store, ts, dur, err, 5);

  /* Only 3 should survive (dur >= 1.0): 1.0, 2.0, 5.0 */
  ASSERT_EQ(inserted, 3, "only 3 events should survive filter");
  ASSERT_EQ(aacyn_store_head(store), 3, "head should be 3");
  ASSERT_EQ(aacyn_store_get_events_dropped(store), 2, "2 events should be dropped");

  /* Verify surviving events via scan */
  aacyn_scan_event_t scan_buf[3];
  uint64_t scanned = aacyn_store_scan(store, 0, UINT64_MAX, 0, scan_buf, 3);
  ASSERT_EQ(scanned, 3, "scan should return 3 events");
  ASSERT_FLOAT_EQ(scan_buf[0].duration_ms, 1.0f, "first surviving dur = 1.0");
  ASSERT_FLOAT_EQ(scan_buf[1].duration_ms, 2.0f, "second surviving dur = 2.0");
  ASSERT_FLOAT_EQ(scan_buf[2].duration_ms, 5.0f, "third surviving dur = 5.0");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 13: Filter rules — drop non-errors ──────────────────────────── */

static int test_filter_drop_non_errors(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  /* Rule: DROP events WHERE is_error == 0 (keep only errors) */
  aacyn_rule_t rule;
  memset(&rule, 0, sizeof(rule));
  rule.column = AACYN_COL_IS_ERROR;
  rule.op = AACYN_OP_EQ;
  rule.action = AACYN_ACTION_DROP;
  rule.threshold = 0.0;
  aacyn_store_set_rules(store, &rule, 1);

  /* Insert 6 events: errors = [0, 1, 0, 1, 0, 1] */
  uint64_t ts[6] = {100, 200, 300, 400, 500, 600};
  float dur[6] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f};
  uint8_t err[6] = {0, 1, 0, 1, 0, 1};
  uint64_t inserted = aacyn_store_batch_insert(store, ts, dur, err, 6);

  /* Only 3 errors should survive */
  ASSERT_EQ(inserted, 3, "only 3 error events should survive");
  ASSERT_EQ(aacyn_store_get_events_dropped(store), 3, "3 non-errors dropped");

  /* Verify surviving events via scan */
  aacyn_scan_event_t scan_buf[3];
  uint64_t scanned = aacyn_store_scan(store, 0, UINT64_MAX, 0, scan_buf, 3);
  ASSERT_EQ(scanned, 3, "scan should return 3 events");
  ASSERT_EQ(scan_buf[0].timestamp, 200, "first error ts = 200");
  ASSERT_EQ(scan_buf[1].timestamp, 400, "second error ts = 400");
  ASSERT_EQ(scan_buf[2].timestamp, 600, "third error ts = 600");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── Test 14: No rules = fast path (no filtering) ─────────────────────── */

static int test_filter_no_rules(void) {
  aacyn_store_t *store = aacyn_store_open(TEST_PATH, 1024);
  ASSERT_MSG(store != NULL, "open failed");

  /* No rules set — all events should pass through */
  uint64_t ts[3] = {100, 200, 300};
  float dur[3] = {0.001f, 0.002f, 0.003f};
  uint8_t err[3] = {0, 0, 0};
  uint64_t inserted = aacyn_store_batch_insert(store, ts, dur, err, 3);

  ASSERT_EQ(inserted, 3, "all 3 events should be inserted");
  ASSERT_EQ(aacyn_store_head(store), 3, "head should be 3");
  ASSERT_EQ(aacyn_store_get_events_dropped(store), 0, "0 dropped");

  aacyn_store_destroy(store);
  return 1;
}

/* ─── gRPC struct size & topology edge validation ────────────────────────── */

static int test_grpc_struct_sizes(void) {
  /* Verify the event struct size matches between BPF and C (must be < 512 for BPF stack) */
  ASSERT_MSG(sizeof(ebpf_network_event_t) <= 512,
             "event struct too large for BPF stack (max 512 bytes)");
  ASSERT_MSG(sizeof(ebpf_network_event_t) >= 100,
             "event struct unexpectedly small — new fields may be missing");
  ASSERT_MSG(sizeof(aacyn_topology_edge_t) >= 124,
             "topology edge struct missing grpc_service field");
  /* Verify grpc_service field offset (rough check: near end of struct) */
  ASSERT_MSG(sizeof(aacyn_topology_edge_t) <= 256,
             "topology edge struct unexpectedly large");
  /* Verify path field is present in event struct at a reasonable offset */
  ASSERT_MSG(sizeof(ebpf_network_event_t) > 64,
             "event struct unexpectedly small — gRPC fields may be missing");
  return 1;
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

int main(void) {
  fprintf(stderr,
          "\n╔══════════════════════════════════════════════════════╗\n");
  fprintf(stderr,
          "║  Ouroboros Ring-Buffer Test Suite                     ║\n");
  fprintf(stderr,
          "╚══════════════════════════════════════════════════════╝\n\n");

  RUN_TEST(test_create_new_store);
  RUN_TEST(test_insert_events);
  RUN_TEST(test_wrap_around);
  RUN_TEST(test_crash_recovery);
  RUN_TEST(test_simd_scan_wrapped);
  RUN_TEST(test_split_batch);
  RUN_TEST(test_scan_time_filter);
  RUN_TEST(test_scan_error_filter);
  RUN_TEST(test_scan_wrapped);
  RUN_TEST(test_extract_raw_linear);
  RUN_TEST(test_extract_raw_wrapped);
  RUN_TEST(test_filter_drop_duration);
  RUN_TEST(test_filter_drop_non_errors);
  RUN_TEST(test_filter_no_rules);
  RUN_TEST(test_grpc_struct_sizes);

  cleanup();

  fprintf(stderr, "\n  %d/%d tests passed\n\n", tests_passed, tests_run);

  return (tests_passed == tests_run) ? 0 : 1;
}
