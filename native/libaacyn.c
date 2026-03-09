/*
 * libaacyn — Native Columnar Store
 *
 * Apache Arrow-compatible Struct of Arrays (SoA) memory layout.
 * Bypasses V8's garbage collector entirely via mmap.
 *
 * Columns:
 *   timestamps : uint64_t[]  — Epoch nanoseconds
 *   durations  : float[]     — Request duration in milliseconds
 *   is_errors  : uint8_t[]   — Boolean error flag (SIMD-friendly)
 *
 * Build:
 *   macOS (ARM):   make            (uses NEON intrinsics)
 *   Linux (x86):   make AVX=1      (uses AVX-512 intrinsics)
 *
 * Exposed to Bun via bun:ffi dlopen.
 */

/* Feature test macros — must come before any includes */
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __linux__
#include <linux/falloc.h>
#include <alloca.h>
#endif

/* ─── SIMD Detection ─────────────────────────────────────────────────────── */

#if defined(__AVX512F__)
#include <immintrin.h>
#define AACYN_SIMD_AVX512 1
#elif defined(__AVX2__)
#include <immintrin.h>
#define AACYN_SIMD_AVX2 1
#elif defined(__ARM_NEON)
#include <arm_neon.h>
#define AACYN_SIMD_NEON 1
#endif

/* ─── Persistent Store Header (64 bytes, 1 cache line) ───────────────────── */

#define AACYN_MAGIC 0x4141434E /* "AACN" */
#define AACYN_VERSION 1

typedef struct __attribute__((packed, aligned(64))) {
  uint32_t magic;    /* 0x4141434E */
  uint32_t version;  /* 1 */
  uint64_t capacity; /* Max events (fixed at creation) */
  uint64_t head;     /* Next write index (monotonic) */
  uint64_t count;    /* Total events stored: min(head, capacity) */
  uint8_t _reserved[32];
} aacyn_store_header_t;

_Static_assert(sizeof(aacyn_store_header_t) == 64,
               "StoreHeader must be exactly 64 bytes (1 cache line)");

/* ─── Declarative Filter Rules ────────────────────────────────────────── */
/*
 * Fixed-size rule struct (16 bytes). An array of these is compiled from
 * aacyn.toml by TypeScript and passed over FFI.
 *
 * Layout:
 *   column    (u8)  — 0 = duration, 1 = is_error, 2 = timestamp
 *   op        (u8)  — 0 = LT, 1 = GT, 2 = EQ, 3 = NEQ, 4 = LTE, 5 = GTE
 *   action    (u8)  — 0 = DROP, 1 = KEEP (future: 2 = ROLLUP)
 *   _pad      (u8)  — padding
 *   threshold (f64) — comparison value (cast to appropriate type at eval)
 *   _reserved (u32) — future use
 */

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

#define AACYN_MAX_RULES 64

typedef struct __attribute__((packed)) {
  uint8_t  column;     /* AACYN_COL_* */
  uint8_t  op;         /* AACYN_OP_*  */
  uint8_t  action;     /* AACYN_ACTION_* */
  uint8_t  _pad;
  double   threshold;  /* comparison value */
  uint32_t _reserved;
} aacyn_rule_t;

_Static_assert(sizeof(aacyn_rule_t) == 16,
               "Rule must be exactly 16 bytes");

/* ─── Columnar Store ─────────────────────────────────────────────────────── */

typedef struct aacyn_store {
  uint64_t *timestamps;
  float *durations;
  uint8_t *is_errors;
  uint64_t len;
  uint64_t capacity;
  /* Track allocation type for correct deallocation (mmap vs aligned_alloc) */
  int ts_is_mmap;
  int dur_is_mmap;
  int err_is_mmap;
  /* Persistent ring-buffer fields */
  aacyn_store_header_t *header; /* NULL for anonymous-memory stores */
  void *mmap_base;              /* mmap base pointer (file-backed) */
  size_t mmap_size;             /* Total mmap size */
  int fd;                       /* File descriptor (-1 for anon) */
  /* Declarative filter rules */
  aacyn_rule_t rules[AACYN_MAX_RULES];
  uint32_t num_rules;
  uint64_t events_dropped;      /* Counter: events dropped by rules */
} aacyn_store_t;

/*
 * Round up to the next page boundary for mmap alignment.
 */
static size_t page_align(size_t bytes) {
  size_t page = (size_t)getpagesize();
  return (bytes + page - 1) & ~(page - 1);
}

/*
 * Allocate a page-aligned memory region via mmap.
 * MAP_ANONYMOUS = no file backing (pure RAM).
 * Falls back to aligned_alloc if mmap fails.
 */
/* Track whether memory was mmap'd (1) or aligned_alloc'd (0) */
typedef struct { void *ptr; int is_mmap; } alloc_record_t;

static void *page_alloc(size_t bytes, int *out_is_mmap) {
  size_t aligned = page_align(bytes);
  void *ptr = mmap(NULL, aligned, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (ptr == MAP_FAILED) {
    /* Fallback for platforms where mmap flags differ */
    ptr = aligned_alloc((size_t)getpagesize(), aligned);
    if (ptr) {
      memset(ptr, 0, aligned);
      if (out_is_mmap) *out_is_mmap = 0;
    }
    return ptr;
  }
  if (out_is_mmap) *out_is_mmap = 1;
  return ptr;
}

static void page_free(void *ptr, size_t bytes, int is_mmap) {
  if (!ptr)
    return;
  if (is_mmap)
    munmap(ptr, page_align(bytes));
  else
    free(ptr);
}

/* ─── Public API (exported to Bun FFI) ───────────────────────────────────── */

/*
 * Create a new columnar store with the given initial capacity.
 * All memory is page-aligned and mmap'd outside the V8 heap.
 *
 * Returns: opaque pointer to aacyn_store_t.
 */
aacyn_store_t *aacyn_store_create(uint64_t capacity) {
  aacyn_store_t *store = (aacyn_store_t *)calloc(1, sizeof(aacyn_store_t));
  if (!store)
    return NULL;

  /* Guard against integer overflow in capacity * sizeof(type) */
  if (capacity > SIZE_MAX / sizeof(uint64_t) ||
      capacity > SIZE_MAX / sizeof(float) ||
      capacity > SIZE_MAX / sizeof(uint8_t)) {
    free(store);
    return NULL;
  }

  store->timestamps = (uint64_t *)page_alloc(capacity * sizeof(uint64_t), &store->ts_is_mmap);
  store->durations  = (float *)page_alloc(capacity * sizeof(float), &store->dur_is_mmap);
  store->is_errors  = (uint8_t *)page_alloc(capacity * sizeof(uint8_t), &store->err_is_mmap);
  store->len = 0;
  store->capacity = capacity;
  store->header = NULL;
  store->mmap_base = NULL;
  store->mmap_size = 0;
  store->fd = -1;

  if (!store->timestamps || !store->durations || !store->is_errors) {
    /* Free any columns that were successfully allocated */
    if (store->timestamps)
      page_free(store->timestamps, capacity * sizeof(uint64_t), store->ts_is_mmap);
    if (store->durations)
      page_free(store->durations, capacity * sizeof(float), store->dur_is_mmap);
    if (store->is_errors)
      page_free(store->is_errors, capacity * sizeof(uint8_t), store->err_is_mmap);
    free(store);
    return NULL;
  }

  return store;
}

/*
 * Open or create a persistent, file-backed ring-buffer store.
 *
 * If the file is new: pre-allocate disk blocks, initialize the header.
 * If the file exists: validate header magic/version, resume from head.
 *
 * The entire file is mmap'd with MAP_SHARED. Column pointers are computed
 * as offsets from the mmap base, past the 64-byte header.
 *
 * Returns: opaque pointer to aacyn_store_t, or NULL on failure.
 */
aacyn_store_t *aacyn_store_open(const char *path, uint64_t capacity) {
  if (!path || capacity == 0)
    return NULL;

  int fd = open(path, O_RDWR | O_CREAT, 0644);
  if (fd < 0) {
    fprintf(stderr, "[libaacyn] ERROR: Cannot open store file: %s (errno=%d)\n",
            path, errno);
    return NULL;
  }

  /* Calculate total file size */
  size_t data_size = (capacity * sizeof(uint64_t)) + /* timestamps */
                     (capacity * sizeof(float)) +    /* durations  */
                     (capacity * sizeof(uint8_t));   /* is_errors  */
  size_t total_size = page_align(sizeof(aacyn_store_header_t) + data_size);

  /* Check if file is new or existing */
  struct stat st;
  if (fstat(fd, &st) < 0) {
    close(fd);
    return NULL;
  }

  int is_new = (st.st_size == 0);

  if (is_new) {
    /* Pre-allocate physical disk blocks */
#ifdef __linux__
    if (fallocate(fd, 0, 0, (off_t)total_size) < 0) {
      /* Fallback to ftruncate if fallocate fails */
      if (ftruncate(fd, (off_t)total_size) < 0) {
        fprintf(stderr, "[libaacyn] ERROR: Cannot allocate store file\n");
        close(fd);
        return NULL;
      }
    }
#else
    /* macOS: ftruncate (no fallocate) */
    if (ftruncate(fd, (off_t)total_size) < 0) {
      fprintf(stderr, "[libaacyn] ERROR: Cannot allocate store file\n");
      close(fd);
      return NULL;
    }
#endif
  } else {
    /* Existing file: verify it's large enough */
    if ((size_t)st.st_size < total_size) {
      fprintf(stderr,
              "[libaacyn] ERROR: Store file too small (%lld < %zu). "
              "Delete and recreate.\n",
              (long long)st.st_size, total_size);
      close(fd);
      return NULL;
    }
  }

  /* mmap the entire file with MAP_SHARED */
  void *base =
      mmap(NULL, total_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (base == MAP_FAILED) {
    fprintf(stderr, "[libaacyn] ERROR: mmap failed (errno=%d)\n", errno);
    close(fd);
    return NULL;
  }

  /* Initialize or validate header */
  aacyn_store_header_t *header = (aacyn_store_header_t *)base;

  if (is_new) {
    memset(header, 0, sizeof(aacyn_store_header_t));
    header->magic = AACYN_MAGIC;
    header->version = AACYN_VERSION;
    header->capacity = capacity;
    header->head = 0;
    header->count = 0;
    msync(base, sizeof(aacyn_store_header_t), MS_SYNC);
  } else {
    /* Validate magic and version */
    if (header->magic != AACYN_MAGIC) {
      fprintf(stderr, "[libaacyn] ERROR: Invalid store magic (0x%08X)\n",
              header->magic);
      munmap(base, total_size);
      close(fd);
      return NULL;
    }
    if (header->version != AACYN_VERSION) {
      fprintf(stderr, "[libaacyn] ERROR: Unsupported store version (%u)\n",
              header->version);
      munmap(base, total_size);
      close(fd);
      return NULL;
    }
    if (header->capacity != capacity) {
      fprintf(stderr,
              "[libaacyn] WARNING: Reopening with stored capacity %llu "
              "(requested %llu)\n",
              (unsigned long long)header->capacity,
              (unsigned long long)capacity);
      capacity = header->capacity;
    }
  }

  /* Allocate store struct */
  aacyn_store_t *store = (aacyn_store_t *)calloc(1, sizeof(aacyn_store_t));
  if (!store) {
    munmap(base, total_size);
    close(fd);
    return NULL;
  }

  /* Compute column pointers as offsets from mmap base */
  uint8_t *data_base = (uint8_t *)base + sizeof(aacyn_store_header_t);
  store->timestamps = (uint64_t *)data_base;
  store->durations = (float *)(data_base + capacity * sizeof(uint64_t));
  store->is_errors = (uint8_t *)(data_base + capacity * sizeof(uint64_t) +
                                 capacity * sizeof(float));
  store->capacity = capacity;
  store->len = header->count;
  store->header = header;
  store->mmap_base = base;
  store->mmap_size = total_size;
  store->fd = fd;

  fprintf(stderr,
          "[libaacyn] %s store: %llu capacity, head=%llu, count=%llu, "
          "%.1fMB mmap'd\n",
          is_new ? "Created" : "Reopened", (unsigned long long)capacity,
          (unsigned long long)header->head, (unsigned long long)header->count,
          (double)total_size / (1024.0 * 1024.0));

  return store;
}

/* ─── Declarative Filter API ─────────────────────────────────────────────── */

/*
 * Set ingestion filter rules. Accepts a packed array of aacyn_rule_t
 * structs compiled by TypeScript from aacyn.toml.
 *
 * Parameters:
 *   store     — the columnar store
 *   rules_buf — pointer to packed aacyn_rule_t array
 *   num_rules — number of rules (max AACYN_MAX_RULES)
 */
void aacyn_store_set_rules(aacyn_store_t *store, const void *rules_buf,
                           uint32_t num_rules) {
  if (!store)
    return;
  if (!rules_buf || num_rules == 0)
    return;

  if (num_rules > AACYN_MAX_RULES)
    num_rules = AACYN_MAX_RULES;

  memcpy(store->rules, rules_buf, num_rules * sizeof(aacyn_rule_t));
  store->num_rules = num_rules;
  store->events_dropped = 0;

  fprintf(stderr, "[libaacyn] Loaded %u filter rules\n",
          (unsigned)num_rules);
}

/*
 * Get the number of events dropped by filter rules.
 */
uint64_t aacyn_store_get_events_dropped(const aacyn_store_t *store) {
  if (!store)
    return 0;
  return store->events_dropped;
}

/*
 * Evaluate a single event against all DROP rules.
 * Returns 1 if the event should be dropped, 0 if it should be kept.
 */
static int eval_rules_should_drop(const aacyn_rule_t *rules,
                                  uint32_t num_rules, uint64_t timestamp,
                                  float duration, uint8_t is_error) {
  for (uint32_t i = 0; i < num_rules; i++) {
    const aacyn_rule_t *r = &rules[i];
    if (r->action != AACYN_ACTION_DROP)
      continue;

    double val;
    switch (r->column) {
    case AACYN_COL_DURATION:
      val = (double)duration;
      break;
    case AACYN_COL_IS_ERROR:
      val = (double)is_error;
      break;
    case AACYN_COL_TIMESTAMP:
      val = (double)timestamp;
      break;
    default:
      continue;
    }

    int match = 0;
    switch (r->op) {
    case AACYN_OP_LT:
      match = (val < r->threshold);
      break;
    case AACYN_OP_GT:
      match = (val > r->threshold);
      break;
    case AACYN_OP_EQ:
      match = (val == r->threshold);
      break;
    case AACYN_OP_NEQ:
      match = (val != r->threshold);
      break;
    case AACYN_OP_LTE:
      match = (val <= r->threshold);
      break;
    case AACYN_OP_GTE:
      match = (val >= r->threshold);
      break;
    }

    if (match)
      return 1; /* Drop this event */
  }
  return 0; /* Keep */
}

/*
 * Batch insert raw columnar data with ring-buffer wrap-around.
 *
 * When filter rules are active, events are evaluated per-event.
 * Matching DROP rules cause the event to be silently discarded.
 * When no rules exist, uses the fast bulk-memcpy path.
 *
 * For anonymous-memory stores: linear append, fails when full.
 * For file-backed stores: wraps using modulo on the monotonic head pointer.
 * Batches straddling the wrap boundary are split into two memcpy calls.
 *
 * Returns: number of records inserted, or 0 on failure.
 */
uint64_t aacyn_store_batch_insert(aacyn_store_t *store,
                                  const uint64_t *timestamps,
                                  const float *durations,
                                  const uint8_t *is_errors, uint64_t count) {
  if (!store || count == 0)
    return 0;

  uint64_t cap = store->capacity;

  /* ── Fast path: no rules → bulk memcpy ─────────────────────────────── */
  if (store->num_rules == 0) {
    if (store->header) {
      uint64_t head = store->header->head;
      uint64_t slot = head % cap;
      uint64_t tail_space = cap - slot;

      if (count <= tail_space) {
        memcpy(store->timestamps + slot, timestamps,
               count * sizeof(uint64_t));
        memcpy(store->durations + slot, durations, count * sizeof(float));
        memcpy(store->is_errors + slot, is_errors, count * sizeof(uint8_t));
      } else {
        memcpy(store->timestamps + slot, timestamps,
               tail_space * sizeof(uint64_t));
        memcpy(store->durations + slot, durations,
               tail_space * sizeof(float));
        memcpy(store->is_errors + slot, is_errors,
               tail_space * sizeof(uint8_t));

        uint64_t wrap_count = count - tail_space;
        memcpy(store->timestamps, timestamps + tail_space,
               wrap_count * sizeof(uint64_t));
        memcpy(store->durations, durations + tail_space,
               wrap_count * sizeof(float));
        memcpy(store->is_errors, is_errors + tail_space,
               wrap_count * sizeof(uint8_t));
      }

      store->header->head = head + count;
      uint64_t new_count =
          store->header->head < cap ? store->header->head : cap;
      store->header->count = new_count;
      store->len = new_count;
      return count;

    } else {
      if (store->len + count > cap)
        return 0;

      memcpy(store->timestamps + store->len, timestamps,
             count * sizeof(uint64_t));
      memcpy(store->durations + store->len, durations,
             count * sizeof(float));
      memcpy(store->is_errors + store->len, is_errors,
             count * sizeof(uint8_t));

      store->len += count;
      return count;
    }
  }

  /* ── Filtered path: evaluate rules per-event ───────────────────────── */
  /* Accumulate surviving events in temp arrays, then single memcpy */
  uint64_t *tmp_ts = (uint64_t *)malloc(count * sizeof(uint64_t));
  float *tmp_dur = (float *)malloc(count * sizeof(float));
  uint8_t *tmp_err = (uint8_t *)malloc(count * sizeof(uint8_t));
  if (!tmp_ts || !tmp_dur || !tmp_err) {
    free(tmp_ts);
    free(tmp_dur);
    free(tmp_err);
    return 0;
  }

  uint64_t kept = 0;
  for (uint64_t i = 0; i < count; i++) {
    if (eval_rules_should_drop(store->rules, store->num_rules,
                               timestamps[i], durations[i], is_errors[i])) {
      store->events_dropped++;
      continue;
    }
    tmp_ts[kept] = timestamps[i];
    tmp_dur[kept] = durations[i];
    tmp_err[kept] = is_errors[i];
    kept++;
  }

  uint64_t inserted = 0;
  if (kept > 0) {
    /* Recurse with num_rules=0 to hit the fast path for the survivors.
     * We temporarily clear rules to avoid infinite recursion. */
    uint32_t saved_rules = store->num_rules;
    store->num_rules = 0;
    inserted = aacyn_store_batch_insert(store, tmp_ts, tmp_dur, tmp_err, kept);
    store->num_rules = saved_rules;
  }

  free(tmp_ts);
  free(tmp_dur);
  free(tmp_err);

  return inserted;
}

/* ─── Accessors ──────────────────────────────────────────────────────────── */

uint64_t aacyn_store_len(const aacyn_store_t *store) {
  return store ? store->len : 0;
}

uint64_t aacyn_store_capacity(const aacyn_store_t *store) {
  return store ? store->capacity : 0;
}

uint64_t aacyn_store_head(const aacyn_store_t *store) {
  if (!store)
    return 0;
  if (store->header)
    return store->header->head;
  return store->len; /* non-persistent: head == len */
}

uint64_t aacyn_store_byte_size(const aacyn_store_t *store) {
  if (!store)
    return 0;
  return (store->capacity * sizeof(uint64_t)) + /* timestamps */
         (store->capacity * sizeof(float)) +    /* durations  */
         (store->capacity * sizeof(uint8_t));   /* is_errors  */
}

/*
 * Synchronously flush all dirty pages to disk.
 * Call on graceful shutdown (SIGTERM) to minimize data loss.
 */
void aacyn_store_sync(aacyn_store_t *store) {
  if (!store || !store->mmap_base)
    return;
  msync(store->mmap_base, store->mmap_size, MS_SYNC);
}

/* ─── SIMD-Accelerated Scans ─────────────────────────────────────────────── */

/*
 * Scan all durations and return the maximum value.
 * Uses AVX-512 (16 floats/cycle), AVX2 (8), NEON (4), or scalar fallback.
 */
float aacyn_store_scan_duration_max(const aacyn_store_t *store) {
  if (!store || store->len == 0)
    return 0.0f;

  uint64_t n = store->len;
  const float *data = store->durations;
  float max_val = data[0];

#if defined(AACYN_SIMD_AVX512)
  /* AVX-512: Process 16 floats per iteration */
  __m512 vmax = _mm512_set1_ps(data[0]);
  uint64_t i = 0;
  for (; i + 16 <= n; i += 16) {
    __m512 v = _mm512_loadu_ps(data + i);
    vmax = _mm512_max_ps(vmax, v);
  }
  max_val = _mm512_reduce_max_ps(vmax);
  /* Scalar tail */
  for (; i < n; i++) {
    if (data[i] > max_val)
      max_val = data[i];
  }

#elif defined(AACYN_SIMD_AVX2)
  /* AVX2: Process 8 floats per iteration */
  __m256 vmax = _mm256_set1_ps(data[0]);
  uint64_t i = 0;
  for (; i + 8 <= n; i += 8) {
    __m256 v = _mm256_loadu_ps(data + i);
    vmax = _mm256_max_ps(vmax, v);
  }
  /* Horizontal reduction */
  __m128 hi = _mm256_extractf128_ps(vmax, 1);
  __m128 lo = _mm256_castps256_ps128(vmax);
  __m128 m = _mm_max_ps(lo, hi);
  m = _mm_max_ps(m, _mm_movehl_ps(m, m));
  m = _mm_max_ss(m, _mm_movehdup_ps(m));
  max_val = _mm_cvtss_f32(m);
  for (; i < n; i++) {
    if (data[i] > max_val)
      max_val = data[i];
  }

#elif defined(AACYN_SIMD_NEON)
  /* ARM NEON: Process 4 floats per iteration */
  float32x4_t vmax = vdupq_n_f32(data[0]);
  uint64_t i = 0;
  for (; i + 4 <= n; i += 4) {
    float32x4_t v = vld1q_f32(data + i);
    vmax = vmaxq_f32(vmax, v);
  }
  max_val = vmaxvq_f32(vmax);
  for (; i < n; i++) {
    if (data[i] > max_val)
      max_val = data[i];
  }

#else
  /* Scalar fallback */
  for (uint64_t i = 1; i < n; i++) {
    if (data[i] > max_val)
      max_val = data[i];
  }
#endif

  return max_val;
}

/*
 * Count total errors using vectorized byte comparison.
 * AVX-512: 64 bytes/cycle via mask + popcount.
 * NEON: 16 bytes/cycle via lane summation.
 */
uint64_t aacyn_store_scan_error_count(const aacyn_store_t *store) {
  if (!store || store->len == 0)
    return 0;

  uint64_t n = store->len;
  const uint8_t *data = store->is_errors;
  uint64_t count = 0;

#if defined(AACYN_SIMD_AVX512)
  /* AVX-512: Process 64 bytes per iteration using mask comparison */
  __m512i vzero = _mm512_setzero_si512();
  uint64_t i = 0;
  for (; i + 64 <= n; i += 64) {
    __m512i v = _mm512_loadu_si512((const __m512i *)(data + i));
    /* Compare each byte != 0, result is a 64-bit mask */
    __mmask64 mask = _mm512_cmpneq_epi8_mask(v, vzero);
    count += (uint64_t)__builtin_popcountll((unsigned long long)mask);
  }
  /* Scalar tail */
  for (; i < n; i++) {
    count += (data[i] != 0);
  }

#elif defined(AACYN_SIMD_NEON)
  /* ARM NEON: Process 16 bytes per iteration */
  uint8x16_t vzero = vdupq_n_u8(0);
  uint64_t i = 0;
  for (; i + 16 <= n; i += 16) {
    uint8x16_t v = vld1q_u8(data + i);
    uint8x16_t cmp = vcgtq_u8(v, vzero);
    count += vaddlvq_u8(vandq_u8(cmp, vdupq_n_u8(1)));
  }
  for (; i < n; i++) {
    count += (data[i] != 0);
  }

#else
  /* Scalar fallback */
  for (uint64_t i = 0; i < n; i++) {
    count += (data[i] != 0);
  }
#endif

  return count;
}

/*
 * Count events with duration exceeding a threshold.
 * AVX-512: _mm512_cmp_ps_mask for 16-wide float comparison.
 * Returns: number of events where duration_ms > threshold.
 *
 * Exported (non-static) for FFI consumption, used by benchmarks and
 * direct C callers. See benchmarks/scan_benchmark.ts.
 */
uint64_t aacyn_store_scan_duration_filter(const aacyn_store_t *store,
                                          float threshold_ms) {
  if (!store || store->len == 0)
    return 0;

  uint64_t n = store->len;
  const float *data = store->durations;
  uint64_t count = 0;

#if defined(AACYN_SIMD_AVX512)
  /* AVX-512: Compare 16 floats per cycle */
  __m512 vthresh = _mm512_set1_ps(threshold_ms);
  uint64_t i = 0;
  for (; i + 16 <= n; i += 16) {
    __m512 v = _mm512_loadu_ps(data + i);
    /* _CMP_GT_OQ = greater-than, ordered, quiet NaN */
    __mmask16 mask = _mm512_cmp_ps_mask(v, vthresh, _CMP_GT_OQ);
    count += (uint64_t)__builtin_popcount((unsigned int)mask);
  }
  for (; i < n; i++) {
    count += (data[i] > threshold_ms);
  }

#elif defined(AACYN_SIMD_NEON)
  /* ARM NEON: Compare 4 floats per cycle */
  float32x4_t vthresh = vdupq_n_f32(threshold_ms);
  uint64_t i = 0;
  for (; i + 4 <= n; i += 4) {
    float32x4_t v = vld1q_f32(data + i);
    uint32x4_t cmp = vcgtq_f32(v, vthresh);
    /* Each lane is 0xFFFFFFFF or 0x00000000; shift right 31 to get 0 or 1 */
    count += vaddvq_u32(vshrq_n_u32(cmp, 31));
  }
  for (; i < n; i++) {
    count += (data[i] > threshold_ms);
  }

#else
  for (uint64_t i = 0; i < n; i++) {
    count += (data[i] > threshold_ms);
  }
#endif

  return count;
}

/* ─── Query Scan (Ring-Buffer Aware) ─────────────────────────────────────── */
/*
 * Scan the ring buffer for events matching the given filters.
 * Writes matching events into a caller-provided output buffer.
 *
 * Output buffer layout (per event, 20 bytes, packed):
 *   offset 0:  uint64_t  timestamp      (8 bytes)
 *   offset 8:  float     duration_ms    (4 bytes)
 *   offset 12: uint32_t  is_error       (4 bytes, zero-extended from uint8)
 *   offset 16: uint32_t  _padding       (4 bytes, zero)
 *
 * Parameters:
 *   store      — the columnar store to scan
 *   start_ns   — minimum timestamp (inclusive), 0 = no lower bound
 *   end_ns     — maximum timestamp (inclusive), 0 = no upper bound
 *   error_only — if 1, only return events where is_error != 0
 *   out_buf    — caller-allocated output buffer
 *   out_cap    — maximum number of events to write
 *
 * Returns: number of events written to out_buf.
 */

typedef struct __attribute__((packed)) {
  uint64_t timestamp;
  float duration_ms;
  uint32_t is_error;
  uint32_t _padding;
} aacyn_scan_event_t;

_Static_assert(sizeof(aacyn_scan_event_t) == 20,
               "ScanEvent must be exactly 20 bytes");

uint64_t aacyn_store_scan(const aacyn_store_t *store, uint64_t start_ns,
                          uint64_t end_ns, int32_t error_only, void *out_buf,
                          uint64_t out_cap) {
  if (!store || store->len == 0 || !out_buf || out_cap == 0)
    return 0;

  aacyn_scan_event_t *out = (aacyn_scan_event_t *)out_buf;
  uint64_t cap = store->capacity;
  uint64_t count = store->len;
  uint64_t written = 0;

  /*
   * Ring-buffer traversal:
   * If head <= capacity, data is at indices [0, count).
   * If head > capacity (wrapped), we scan all capacity slots.
   * In both cases we scan exactly 'count' valid events.
   *
   * For wrapped stores, the oldest event is at (head % cap).
   * We iterate from oldest → newest so the output is time-ordered.
   */
  uint64_t head = store->header ? store->header->head : store->len;
  uint64_t start_slot;

  if (head <= cap) {
    /* No wrap — data is contiguous from 0 to count-1 */
    start_slot = 0;
  } else {
    /* Wrapped — oldest is at head % cap */
    start_slot = head % cap;
  }

  for (uint64_t i = 0; i < count && written < out_cap; i++) {
    uint64_t idx = (start_slot + i) % cap;

    uint64_t ts = store->timestamps[idx];
    float dur = store->durations[idx];
    uint8_t err = store->is_errors[idx];

    /* Time filter */
    if (start_ns > 0 && ts < start_ns)
      continue;
    if (end_ns > 0 && ts > end_ns)
      continue;

    /* Error filter */
    if (error_only && !err)
      continue;

    out[written].timestamp = ts;
    out[written].duration_ms = dur;
    out[written].is_error = (uint32_t)err;
    out[written]._padding = 0;
    written++;
  }

  return written;
}

/* ─── Raw Byte Extraction (Archiver) ─────────────────────────────────────── */
/*
 * Extract raw columnar bytes for a range of events specified by
 * monotonic head indices: [from_head, from_head + count).
 *
 * Output buffer layout (SoA, highly compressible):
 *   [timestamps: count * 8B] [durations: count * 4B] [is_errors: count * 1B]
 *   Total = count * 13 bytes.
 *
 * The function handles wrap-around: if the index range straddles the
 * capacity boundary, it performs two memcpy calls per column.
 *
 * Parameters:
 *   store     — the columnar store
 *   from_head — starting monotonic head index (inclusive)
 *   count     — number of events to extract
 *   out_buf   — caller-allocated buffer, must be >= count * 13 bytes
 *
 * Returns: number of events actually extracted (may be < count if
 *          the requested range extends beyond valid data).
 */
uint64_t aacyn_store_extract_raw(const aacyn_store_t *store, uint64_t from_head,
                                 uint64_t count, void *out_buf) {
  if (!store || !out_buf || count == 0)
    return 0;

  uint64_t cap = store->capacity;
  uint64_t current_head = store->header ? store->header->head : store->len;

  /* Clamp: don't extract beyond what's been written.
     Guard against overflow: if from_head + count wraps, clamp to current_head - from_head */
  if (count > current_head || from_head > current_head - count) {
    count = (current_head > from_head) ? current_head - from_head : 0;
  } else if (from_head + count > current_head) {
    count = current_head - from_head;
  }
  if (count == 0)
    return 0;

  /* Clamp: don't try to extract data that's been overwritten */
  uint64_t oldest_head = (current_head > cap) ? (current_head - cap) : 0;
  if (from_head < oldest_head) {
    uint64_t skip = oldest_head - from_head;
    if (skip >= count)
      return 0;
    from_head = oldest_head;
    count -= skip;
  }

  uint8_t *out = (uint8_t *)out_buf;
  uint64_t slot = from_head % cap;
  uint64_t tail = cap - slot;

  /* ── Timestamps (8 bytes each) ─────────────────────────────────────── */
  uint8_t *ts_out = out;
  if (count <= tail) {
    memcpy(ts_out, store->timestamps + slot, count * sizeof(uint64_t));
  } else {
    memcpy(ts_out, store->timestamps + slot, tail * sizeof(uint64_t));
    memcpy(ts_out + tail * sizeof(uint64_t), store->timestamps,
           (count - tail) * sizeof(uint64_t));
  }

  /* ── Durations (4 bytes each) ──────────────────────────────────────── */
  uint8_t *dur_out = out + count * sizeof(uint64_t);
  if (count <= tail) {
    memcpy(dur_out, store->durations + slot, count * sizeof(float));
  } else {
    memcpy(dur_out, store->durations + slot, tail * sizeof(float));
    memcpy(dur_out + tail * sizeof(float), store->durations,
           (count - tail) * sizeof(float));
  }

  /* ── Is-Errors (1 byte each) ───────────────────────────────────────── */
  uint8_t *err_out = out + count * sizeof(uint64_t) + count * sizeof(float);
  if (count <= tail) {
    memcpy(err_out, store->is_errors + slot, count * sizeof(uint8_t));
  } else {
    memcpy(err_out, store->is_errors + slot, tail * sizeof(uint8_t));
    memcpy(err_out + tail * sizeof(uint8_t), store->is_errors,
           (count - tail) * sizeof(uint8_t));
  }

  return count;
}

/* ─── FlatBuffers Binary Ingestion (Zero-Parse) ──────────────────────────── */
/*
 * FlatBuffers wire format for our TelemetryBatch schema:
 *
 * EventStruct (FlatBuffers struct — stored inline, 16 bytes):
 *   offset 0:  uint64_t  timestamp      (8 bytes)
 *   offset 8:  float     duration_ms    (4 bytes)
 *   offset 12: uint16_t  status_code    (2 bytes)
 *   offset 14: uint16_t  _padding       (2 bytes)
 *
 * TelemetryBatch (FlatBuffers table):
 *   Root: 4-byte uoffset to table
 *   Table: soffset to vtable, then field data at vtable-specified offsets
 *   VTable: [vtable_size:u16] [obj_size:u16] [field_0_off:u16]
 * [field_1_off:u16] Field 0: trace_id (string offset) Field 1: events (vector
 * of inline EventStruct)
 *
 * This reader assumes the standard FlatBuffers little-endian wire format.
 */

/* Packed struct matching the FlatBuffers EventStruct layout */
typedef struct __attribute__((packed)) {
  uint64_t timestamp;
  float duration_ms;
  uint16_t status_code;
  uint16_t _padding;
} flatbuf_event_t;

_Static_assert(sizeof(flatbuf_event_t) == 16, "EventStruct must be 16 bytes");

/*
 * Read a FlatBuffer binary payload and shred directly into the SoA store.
 *
 * Hot path: ZERO memory allocation. Reads offsets from the buffer,
 * locates the inline EventStruct vector, and memcpys the columnar
 * fields directly into the mmap'd store.
 *
 * Returns: number of events ingested, or 0 on error.
 */
uint64_t aacyn_store_ingest_flatbuf(aacyn_store_t *store, const uint8_t *buf,
                                    uint64_t buf_len) {
  if (!store || !buf || buf_len < 8)
    return 0;

  /* Step 1: Read root table offset (first 4 bytes) */
  uint32_t root_offset;
  memcpy(&root_offset, buf, 4);
  if (root_offset >= buf_len)
    return 0;

  const uint8_t *table = buf + root_offset;

  /* Step 2: Read vtable offset (signed, subtracted from table position) */
  int32_t vtable_soffset;
  memcpy(&vtable_soffset, table, 4);
  const uint8_t *vtable = table - vtable_soffset;

  /* Bounds check: vtable must point within the buffer */
  if (vtable < buf || vtable + 6 >= buf + buf_len)
    return 0; /* vtable points outside buffer — malformed or malicious payload */

  /* Step 3: Read vtable metadata */
  uint16_t vtable_size;
  memcpy(&vtable_size, vtable, 2);
  if (vtable_size < 8)
    return 0; /* Need at least 2 field offsets */

  /* Step 4: Read events field offset (field index 1, at vtable + 6) */
  uint16_t events_field_offset;
  memcpy(&events_field_offset, vtable + 6, 2);
  if (events_field_offset == 0)
    return 0; /* Field not present */

  /* Step 5: Follow the events offset to the vector */
  const uint8_t *events_offset_ptr = table + events_field_offset;
  uint32_t events_uoffset;
  memcpy(&events_uoffset, events_offset_ptr, 4);
  const uint8_t *vector_ptr = events_offset_ptr + events_uoffset;

  /* Step 6: Read vector length */
  uint32_t event_count;
  memcpy(&event_count, vector_ptr, 4);
  if (event_count == 0)
    return 0;

  /* Bounds check */
  const uint8_t *events_data = vector_ptr + 4;
  uint64_t events_bytes = (uint64_t)event_count * sizeof(flatbuf_event_t);
  if (events_data + events_bytes > buf + buf_len)
    return 0;

  /* Step 7: Shred inline structs into temporary arrays, then batch insert */
  const flatbuf_event_t *events = (const flatbuf_event_t *)events_data;

  /* For small batches, use stack allocation. For large, use heap. */
  uint64_t *tmp_ts;
  float *tmp_dur;
  uint8_t *tmp_err;
  int heap_alloc = (event_count > 4096);

  if (heap_alloc) {
    tmp_ts = (uint64_t *)malloc(event_count * sizeof(uint64_t));
    tmp_dur = (float *)malloc(event_count * sizeof(float));
    tmp_err = (uint8_t *)malloc(event_count * sizeof(uint8_t));
    if (!tmp_ts || !tmp_dur || !tmp_err) {
      free(tmp_ts);
      free(tmp_dur);
      free(tmp_err);
      return 0;
    }
  } else {
    tmp_ts = (uint64_t *)alloca(event_count * sizeof(uint64_t));
    tmp_dur = (float *)alloca(event_count * sizeof(float));
    tmp_err = (uint8_t *)alloca(event_count * sizeof(uint8_t));
  }

  for (uint32_t i = 0; i < event_count; i++) {
    tmp_ts[i] = events[i].timestamp;
    tmp_dur[i] = events[i].duration_ms;
    tmp_err[i] = (events[i].status_code >= 400) ? 1 : 0;
  }

  uint64_t inserted =
      aacyn_store_batch_insert(store, tmp_ts, tmp_dur, tmp_err, event_count);

  if (heap_alloc) {
    free(tmp_ts);
    free(tmp_dur);
    free(tmp_err);
  }

  return inserted;
}

/* ─── eBPF Ring Buffer Consumer ──────────────────────────────────────────── */
/*
 * On Linux: Uses libbpf to drain the eBPF ring buffer populated by
 *           aacyn_probes.bpf.c and append kernel events into the SoA store.
 *
 * On macOS: Stubs that return 0 — eBPF is not available on Darwin.
 */

/* Matches the struct in aacyn_probes.bpf.c */
typedef struct __attribute__((packed)) {
  uint64_t timestamp_ns;
  uint32_t pid;
  uint32_t tgid;
  uint32_t dest_ip;
  uint32_t source_ip;   /* Container's bridge IP — node identity */
  uint16_t dest_port;
  uint16_t status;      /* 0=connect, 1=connected, 2=send, 3=failed, 4=retransmit, 5=HTTP/gRPC req, 6=resp */
  uint8_t  protocol;    /* 0=unknown, 1=HTTP/1.x, 2=HTTP/2, 3=gRPC */
  uint8_t  path_len;    /* Length of path string in path[] */
  uint64_t bytes;       /* HTTP: (http_status<<16)|(method<<8)|path_len; gRPC: (status<<16) */
  char comm[16];
  /* Distributed Tracing (v2) */
  char trace_id[16];    /* 128-bit W3C trace ID */
  uint64_t span_id;     /* 64-bit span ID */
  uint64_t parent_span_id; /* 64-bit parent span ID */
  char path[32];        /* HTTP: request path; gRPC: "service:method" */
} ebpf_network_event_t;

/* ─── Trace Span Buffer ──────────────────────────────────────────────────── */
/*
 * Fixed-size ring buffer for trace spans extracted from eBPF events.
 * TypeScript drains this via FFI to build the trace tree.
 * The ring buffer wraps: oldest entries are silently overwritten when full.
 */

#define AACYN_TRACE_MAX_SPANS 4096

typedef struct __attribute__((packed)) {
  uint64_t timestamp_ns;
  char trace_id[16];
  uint64_t span_id;
  uint64_t parent_span_id;
  uint32_t dest_ip;
  uint16_t dest_port;
  uint16_t status;      /* 0=connect, 1=connected, 2=send, 3=failed, 4=retransmit, 5=HTTP req, 6=HTTP resp */
  uint8_t  protocol;    /* 0=unknown, 1=HTTP/1.x, 2=HTTP/2, 3=gRPC */
  uint8_t  _pad1;
  uint32_t pid;
  char comm[16];
  uint64_t bytes;       /* For HTTP: (status_code << 16) | (method << 8) | path_len */
  uint8_t is_error;
  uint8_t _pad[7];
} aacyn_trace_span_t;

_Static_assert(sizeof(aacyn_trace_span_t) == 86,
               "TraceSpan must be exactly 86 bytes (matches TS SPAN_SIZE)");

/* ── Topology Edge Tracking ─────────────────────────────────────────────── */
/* Tracks source_comm → dest_ip:dest_port edges for the topology API.       */

#define AACYN_MAX_TOPO_EDGES 512

typedef struct {
  char source_comm[16]; /* Process name making the connect() call */
  char container_id[16]; /* Container ID from /proc/[pid]/cgroup (K8s/Docker) */
  uint32_t source_ip;   /* Source IPv4 (network byte order) — container identity */
  uint32_t dest_ip;     /* Destination IPv4 (network byte order) */
  uint16_t dest_port;   /* Destination port (host byte order) */
  uint16_t _pad;
  uint64_t hit_count;   /* Number of connections observed */
  uint64_t total_latency_ns; /* Cumulative connect() duration */
  uint64_t last_seen_ns;     /* Most recent timestamp */
  uint64_t total_bytes;      /* Cumulative bytes from tcp_sendmsg */
  uint64_t error_count;      /* Failed connect() attempts */
  uint64_t retransmit_count; /* TCP retransmits observed */
  char grpc_service[32];     /* gRPC service:method (e.g. "helloworld.Greeter:SayHello") */
} aacyn_topology_edge_t;

_Static_assert(sizeof(aacyn_topology_edge_t) == 128,
               "TopologyEdge must be exactly 128 bytes (matches TS RECORD_SIZE)");

#ifdef AACYN_HAS_LIBBPF

static aacyn_trace_span_t g_trace_spans[AACYN_TRACE_MAX_SPANS];
static uint32_t g_trace_span_count = 0;

/*
 * Append a trace span to the ring buffer (wraps at capacity).
 * Called from ebpf_event_handler inside AACYN_HAS_LIBBPF.
 */
static void trace_span_append(const aacyn_trace_span_t *span) {
  uint32_t idx = g_trace_span_count % AACYN_TRACE_MAX_SPANS;
  g_trace_spans[idx] = *span;
  g_trace_span_count++;
}

/* ── eBPF Consumer (requires libbpf — set EBPF=1 in Makefile) ────────────── */
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <errno.h>
#include <stdio.h>

static aacyn_store_t *g_ebpf_store = NULL;
static struct bpf_object *g_bpf_obj = NULL;
static struct ring_buffer *g_ringbuf = NULL;
static uint64_t g_ebpf_events_total = 0;
static int g_drop_counters_fd = -1;      /* V2: Per-CPU drop counter map fd */
static int g_num_cpus = 0;               /* V2: cached CPU count for aggregation */


/*
 * Extract the container ID from /proc/<pid>/cgroup.
 * On Kubernetes: /kubepods/.../pod<uid>/<container-id>
 * On Docker:     /docker/<container-id>
 * On containerd: /system.slice/containerd.service/.../<container-id>
 *
 * Returns the number of bytes written to buf (excluding null terminator).
 * Returns 0 if no container ID could be extracted.
 */
static uint32_t read_container_id(uint32_t pid, char *buf, uint32_t bufsize) {
  char path[64];
  int written = snprintf(path, sizeof(path), "/proc/%u/cgroup", pid);
  if (written < 0 || (size_t)written >= sizeof(path))
    return 0;

  FILE *f = fopen(path, "r");
  if (!f) return 0; /* Process may have exited or /proc not mounted */

  char line[256];
  uint32_t best_len = 0;

  while (fgets(line, sizeof(line), f)) {
    /* Find the last '/' in the line — the container ID follows it */
    char *last_slash = strrchr(line, '/');
    if (!last_slash) continue;

    char *container = last_slash + 1;
    /* Strip trailing newline and any scope suffix (e.g., ".scope") */
    char *end = strpbrk(container, "\n\r.");
    uint32_t len;
    if (end)
      len = (uint32_t)(end - container);
    else
      len = (uint32_t)strlen(container);

    if (len == 0 || len >= bufsize) continue;

    /* Prefer Kubernetes pod containers (longest ID with meaningful prefix) */
    /* Skip cgroup entries that are just numbers or too short to be real IDs */
    if (len >= 12) {
      memcpy(buf, container, len);
      buf[len] = '\0';
      best_len = len;
      /* Check if this line contains "pod" — highest priority */
      if (strstr(line, "pod")) {
        break; /* Found a K8s pod container ID — use it */
      }
    }
  }

  fclose(f);
  return best_len;
}

static aacyn_topology_edge_t g_topo_edges[AACYN_MAX_TOPO_EDGES];
static uint32_t g_topo_edge_count = 0;

/*
 * Lookup-only: find an existing edge but never create.
 * Used by tcp_sendmsg and connect_failed to accumulate data on
 * edges that were already created by connect-exit. This prevents
 * ephemeral-port edges (e.g. postgres→node:47832) from exploding
 * the topology graph.
 */
/*
 * Match an edge by identity. Prefers container_id (K8s pod identity)
 * over source_comm (raw process name). Two edges match if they share
 * the same container_id (or comm if no container), source_ip, dest_ip,
 * and dest_port.
 */
static int edge_matches(const aacyn_topology_edge_t *edge,
                        const char *comm, const char *container_id,
                        uint32_t source_ip, uint32_t dest_ip,
                        uint16_t dest_port) {
  if (edge->dest_ip != dest_ip || edge->dest_port != dest_port)
    return 0;
  if (edge->source_ip != source_ip)
    return 0;

  /* Primary match: container_id (pod-scoped identity) */
  if (container_id[0] != '\0' && edge->container_id[0] != '\0') {
    return strncmp(edge->container_id, container_id, 15) == 0;
  }

  /* Fallback: process name (bare metal / non-containerized) */
  return strncmp(edge->source_comm, comm, 15) == 0;
}

static aacyn_topology_edge_t *
find_edge(const char *comm, const char *container_id,
          uint32_t source_ip, uint32_t dest_ip, uint16_t dest_port) {
  for (uint32_t i = 0; i < g_topo_edge_count; i++) {
    if (edge_matches(&g_topo_edges[i], comm, container_id,
                     source_ip, dest_ip, dest_port)) {
      return &g_topo_edges[i];
    }
  }
  return NULL; /* not found — do NOT create */
}

static aacyn_topology_edge_t *
find_or_create_edge(const char *comm, const char *container_id,
                    uint32_t source_ip, uint32_t dest_ip,
                    uint16_t dest_port) {
  /* Try lookup first */
  aacyn_topology_edge_t *existing =
      find_edge(comm, container_id, source_ip, dest_ip, dest_port);
  if (existing) return existing;

  if (g_topo_edge_count >= AACYN_MAX_TOPO_EDGES)
    return NULL;
  aacyn_topology_edge_t *edge = &g_topo_edges[g_topo_edge_count++];
  memset(edge, 0, sizeof(*edge));
  strncpy(edge->source_comm, comm, 15);
  edge->source_comm[15] = '\0';
  strncpy(edge->container_id, container_id, 15);
  edge->container_id[15] = '\0';
  edge->source_ip = source_ip;
  edge->dest_ip = dest_ip;
  edge->dest_port = dest_port;
  return edge;
}

/*
 * Ring buffer callback — invoked for each event submitted by the BPF probes.
 * Shreds the kernel struct directly into the SoA mmap store.
 * ZERO allocation on the hot path.
 */
static int ebpf_event_handler(void *ctx, void *data, size_t data_sz) {
  (void)ctx;
  if (!g_ebpf_store || data_sz < sizeof(ebpf_network_event_t))
    return 0;

  const ebpf_network_event_t *event = (const ebpf_network_event_t *)data;

  /* Use batch_insert for ring-buffer-safe insertion */
  uint64_t ts = event->timestamp_ns;
  float dur = (float)(event->bytes) / 1000000.0f;
  uint8_t err = (event->status >= 400) ? 1 : 0;
  aacyn_store_batch_insert(g_ebpf_store, &ts, &dur, &err, 1);
  g_ebpf_events_total++;

  /*
   * Extract container ID from /proc/[pid]/cgroup for K8s pod identity.
   * Falls back to process name (comm) on bare metal / non-containerized hosts.
   * Cached per PID to avoid repeated /proc reads for high-frequency events.
   */
  char container_id[16] = {0};
  static uint32_t cached_pid = 0;
  static char cached_container[16] = {0};
  static uint64_t cache_ts = 0;

  if (event->pid == cached_pid && (ts - cache_ts) < 1000000000ULL /* 1s */) {
    memcpy(container_id, cached_container, 16);
  } else {
    uint32_t id_len = read_container_id(event->pid, container_id, 16);
    if (id_len > 0) {
      cached_pid = event->pid;
      memcpy(cached_container, container_id, 16);
      cache_ts = ts;
    }
  }

  /* ── Enrich service discovery + topology ──────────────────────────────── */
  if (event->status == 0 && event->dest_ip != 0) {
    /* connect-enter: register the destination for service discovery */
    uint16_t port_host = __builtin_bswap16(event->dest_port);
    aacyn_discovery_register(event->pid, port_host,
                             event->comm, event->timestamp_ns);
  } else if (event->status == 1 && event->dest_ip != 0) {
    /*
     * connect-exit: source_ip is now populated from socket introspection.
     * THIS is where we create/update topology edges — the authoritative
     * event with full (source_ip, dest_ip, dest_port) identification.
     */
    uint16_t port_host = __builtin_bswap16(event->dest_port);
    aacyn_topology_edge_t *edge =
        find_or_create_edge(event->comm, container_id,
                            event->source_ip, event->dest_ip, port_host);
    if (edge) {
      edge->hit_count++;
      edge->last_seen_ns = ts;
      /* bytes field contains duration_ns on connect-exit events */
      edge->total_latency_ns += event->bytes;
    }
  } else if (event->status == 2 && event->dest_ip != 0) {
    /*
     * tcp_sendmsg: accumulate bytes transferred on EXISTING edges only.
     * Do NOT create new edges — ephemeral ports (e.g. response traffic
     * postgres→node:47832) would explode the topology graph.
     */
    uint16_t port_host = __builtin_bswap16(event->dest_port);
    aacyn_topology_edge_t *edge =
        find_edge(event->comm, container_id,
                  event->source_ip, event->dest_ip, port_host);
    if (edge) {
      edge->total_bytes += event->bytes;
      edge->last_seen_ns = ts;
    }
  } else if (event->status == 3 && event->dest_ip != 0) {
    /*
     * connect_failed: increment error counter on EXISTING edges only.
     */
    uint16_t port_host = __builtin_bswap16(event->dest_port);
    aacyn_topology_edge_t *edge =
        find_edge(event->comm, container_id,
                  event->source_ip, event->dest_ip, port_host);
    if (edge) {
      edge->error_count++;
      edge->last_seen_ns = ts;
    }
  } else if (event->status == 4 && event->dest_ip != 0) {
    /*
     * tcp_retransmit: increment retransmit counter on EXISTING edges.
     */
    uint16_t port_host = __builtin_bswap16(event->dest_port);
    aacyn_topology_edge_t *edge =
        find_edge(event->comm, container_id,
                  event->source_ip, event->dest_ip, port_host);
    if (edge) {
      edge->retransmit_count++;
      edge->last_seen_ns = ts;
    }
  } else if ((event->status == 5 || event->status == 6) && event->dest_ip != 0) {
    /*
     * HTTP/gRPC request (status=5) or response (status=6).
     * bytes field encodes: (http_status_code << 16) | (method << 8) | path_len
     *   method: 0=unknown, 1=GET, 2=POST, 3=PUT, 4=DELETE, 5=PATCH, 6=HEAD
     * protocol: 0=unknown, 1=HTTP/1.x, 2=HTTP/2, 3=gRPC
     * These events flow into the columnar store for dashboard RED metrics.
     *
     * For gRPC (protocol == 3), the path field contains "service:method".
     */
    uint16_t port_host = __builtin_bswap16(event->dest_port);
    aacyn_topology_edge_t *edge =
        find_edge(event->comm, container_id,
                  event->source_ip, event->dest_ip, port_host);
    if (edge) {
      edge->last_seen_ns = ts;
      /* If this is a gRPC event, store the service:method on the edge */
      if (event->protocol == 3 && event->path_len > 0) {
        size_t copy_len = event->path_len < 32 ? event->path_len : 31;
        memcpy(edge->grpc_service, event->path, copy_len);
        edge->grpc_service[copy_len] = '\0';
      }
    }
  }

  /* ── Extract trace span from events with trace context ──────────────────── */
  {
    int trace_nonzero = 0;
    for (int i = 0; i < 16 && !trace_nonzero; i++) {
      if (event->trace_id[i] != 0) trace_nonzero = 1;
    }
    if (trace_nonzero) {
      aacyn_trace_span_t span;
      span.timestamp_ns = event->timestamp_ns;
      __builtin_memcpy(span.trace_id, event->trace_id, 16);
      span.span_id = event->span_id;
      span.parent_span_id = event->parent_span_id;
      span.dest_ip = event->dest_ip;
      span.dest_port = __builtin_bswap16(event->dest_port);
      span.status = event->status;
      span.protocol = event->protocol;
      span._pad1 = 0;
      span.pid = event->pid;
      __builtin_memcpy(span.comm, event->comm, 16);
      span.bytes = event->bytes;
      /* Decode is_error from bytes field for HTTP events */
      if (event->status == 3) {
        span.is_error = 1; /* connect_failed */
      } else if (event->status == 5 || event->status == 6) {
        __u64 http_status = (event->bytes >> 16) & 0xFFFF;
        span.is_error = (http_status >= 400) ? 1 : 0;
      } else {
        span.is_error = 0;
      }
      memset(span._pad, 0, 7);
      trace_span_append(&span);
    }
  }

  return 0;
}

/*
 * Attach eBPF probes from a compiled BPF object file.
 *
 * Lifecycle:
 *   1. Open the .bpf.o file via bpf_object__open_file
 *   2. Load into kernel via bpf_object__load
 *   3. Attach all programs (tracepoints, kprobes)
 *   4. Find the "events_ringbuf" map and create a ring_buffer consumer
 *
 * Returns: 0 on success, negative error code on failure.
 *   -1:  Failed to open BPF object file
 *   -2:  Failed to load BPF programs into kernel
 *   -3:  Failed to attach a BPF program
 *   -4:  Ring buffer map not found
 *   -5:  Failed to create ring buffer consumer
 */
int aacyn_ebpf_attach(aacyn_store_t *store, const char *bpf_obj_path) {
  if (!store || !bpf_obj_path)
    return -1;

  g_ebpf_store = store;
  g_ebpf_events_total = 0;

  /* Cache CPU count for Per-CPU array reads */
  g_num_cpus = libbpf_num_possible_cpus();
  if (g_num_cpus <= 0) g_num_cpus = 1;

  /* Step 1: Open BPF object file */
  g_bpf_obj = bpf_object__open_file(bpf_obj_path, NULL);
  if (!g_bpf_obj) {
    fprintf(stderr,
            "[libaacyn] ERROR: Failed to open BPF object: %s\n"
            "  Ensure the file exists and was compiled with:\n"
            "  clang -target bpf -O2 -g -c aacyn_probes.bpf.c -o %s\n",
            bpf_obj_path, bpf_obj_path);
    return -1;
  }

  /* Step 2: Load BPF programs into kernel */
  int err = bpf_object__load(g_bpf_obj);
  if (err) {
    fprintf(stderr,
            "[libaacyn] ERROR: Failed to load BPF programs (errno=%d)\n"
            "  Ensure you are running as root with CAP_BPF capability.\n"
            "  On Ubuntu 24.04: sudo setcap cap_bpf+ep <binary>\n"
            "  Or run with: sudo bun run src/index.ts\n",
            -err);
    bpf_object__close(g_bpf_obj);
    g_bpf_obj = NULL;
    return -2;
  }

  /* Step 3: Attach all BPF programs */
  struct bpf_program *prog;
  bpf_object__for_each_program(prog, g_bpf_obj) {
    struct bpf_link *link = bpf_program__attach(prog);
    if (!link) {
      fprintf(stderr,
              "[libaacyn] ERROR: Failed to attach BPF program: %s\n"
              "  Check that the tracepoint/kprobe exists on this kernel.\n"
              "  Run: cat /sys/kernel/debug/tracing/available_events | grep "
              "sys_enter_connect\n",
              bpf_program__name(prog));
      bpf_object__close(g_bpf_obj);
      g_bpf_obj = NULL;
      return -3;
    }
  }

  /* Step 4: V2 — Find BOTH ring buffer maps */
  int standard_fd =
      bpf_object__find_map_fd_by_name(g_bpf_obj, "standard_events");
  if (standard_fd < 0) {
    fprintf(stderr,
            "[libaacyn] ERROR: Ring buffer map 'standard_events' not found.\n"
            "  V2 requires dual ring buffers. Rebuild aacyn_probes.bpf.o.\n");
    bpf_object__close(g_bpf_obj);
    g_bpf_obj = NULL;
    return -4;
  }

  int critical_fd =
      bpf_object__find_map_fd_by_name(g_bpf_obj, "critical_errors");
  if (critical_fd < 0) {
    fprintf(stderr,
            "[libaacyn] ERROR: Ring buffer map 'critical_errors' not found.\n"
            "  V2 requires dual ring buffers. Rebuild aacyn_probes.bpf.o.\n");
    bpf_object__close(g_bpf_obj);
    g_bpf_obj = NULL;
    return -4;
  }

  /* Step 4b: V2 — Find drop counters Per-CPU array */
  g_drop_counters_fd =
      bpf_object__find_map_fd_by_name(g_bpf_obj, "drop_counters");
  if (g_drop_counters_fd < 0) {
    fprintf(stderr,
            "[libaacyn] WARN: drop_counters map not found. "
            "Backpressure monitoring disabled.\n");
    /* Non-fatal — continue without drop tracking */
  }

  /* Step 5: V2 — Create ring buffer consumer for BOTH buffers */
  /* critical_errors first (higher priority polling) */
  g_ringbuf = ring_buffer__new(critical_fd, ebpf_event_handler, NULL, NULL);
  if (!g_ringbuf) {
    fprintf(
        stderr,
        "[libaacyn] ERROR: Failed to create ring buffer consumer (errno=%d)\n",
        errno);
    bpf_object__close(g_bpf_obj);
    g_bpf_obj = NULL;
    return -5;
  }

  /* Add standard_events to the same polling instance */
  err = ring_buffer__add(g_ringbuf, standard_fd, ebpf_event_handler, NULL);
  if (err) {
    fprintf(stderr,
            "[libaacyn] ERROR: Failed to add standard_events ring buffer "
            "(errno=%d)\n",
            -err);
    ring_buffer__free(g_ringbuf);
    g_ringbuf = NULL;
    bpf_object__close(g_bpf_obj);
    g_bpf_obj = NULL;
    return -5;
  }

  fprintf(stderr,
          "[libaacyn] V2 eBPF probes attached: %s\n"
          "  standard_events (256KB) + critical_errors (64KB) + "
          "drop_counters (Per-CPU)\n",
          bpf_obj_path);
  return 0;
}

/*
 * Poll the eBPF ring buffer for new events.
 * Returns: number of events consumed, or negative on error.
 */
int aacyn_ebpf_poll(int timeout_ms) {
  if (!g_ringbuf)
    return 0;
  return ring_buffer__poll(g_ringbuf, timeout_ms);
}

/*
 * Detach all eBPF probes and free resources.
 */
void aacyn_ebpf_detach(void) {
  if (g_ringbuf) {
    ring_buffer__free(g_ringbuf);
    g_ringbuf = NULL;
  }
  if (g_bpf_obj) {
    bpf_object__close(g_bpf_obj);
    g_bpf_obj = NULL;
  }
  g_ebpf_store = NULL;
  g_drop_counters_fd = -1;
  fprintf(stderr,
          "[libaacyn] eBPF probes detached. Total events drained: %lu\n",
          (unsigned long)g_ebpf_events_total);
}

uint64_t aacyn_ebpf_drain_count(void) { return g_ebpf_events_total; }

/*
 * V2: Read observable backpressure counters.
 *
 * The BPF drop_counters map is a BPF_MAP_TYPE_PERCPU_ARRAY with 2 keys:
 *   Index 0: standard event drops
 *   Index 1: critical event drops
 *
 * Each CPU maintains its own counter to avoid cache-line bouncing.
 * We aggregate across all CPUs here.
 */
void aacyn_get_drop_counts(uint64_t *standard_drops, uint64_t *critical_drops) {
  *standard_drops = 0;
  *critical_drops = 0;

  if (g_drop_counters_fd < 0 || g_num_cpus <= 0)
    return;

  /* Per-CPU read buffer: one uint64_t per possible CPU */
  uint64_t *percpu_values =
      (uint64_t *)alloca((size_t)g_num_cpus * sizeof(uint64_t));

  /* Aggregate standard drops (index 0) */
  uint32_t key = 0;
  if (bpf_map_lookup_elem(g_drop_counters_fd, &key, percpu_values) == 0) {
    for (int i = 0; i < g_num_cpus; i++)
      *standard_drops += percpu_values[i];
  }

  /* Aggregate critical drops (index 1) */
  key = 1;
  if (bpf_map_lookup_elem(g_drop_counters_fd, &key, percpu_values) == 0) {
    for (int i = 0; i < g_num_cpus; i++)
      *critical_drops += percpu_values[i];
  }
}

/* ── Topology FFI (inside AACYN_HAS_LIBBPF block) ───────────────────────── */

uint32_t aacyn_topology_count(void) { return g_topo_edge_count; }

int aacyn_topology_get(uint32_t index, void *out_buf) {
  if (index >= g_topo_edge_count || !out_buf)
    return 0;
  memcpy(out_buf, &g_topo_edges[index], sizeof(aacyn_topology_edge_t));
  return 1;
}

/* ── Trace Span FFI ─────────────────────────────────────────────────────── */
/*
 * Drain trace spans from the eBPF event handler.
 * TypeScript polls aacyn_trace_span_count() to detect new spans,
 * then reads individual spans with aacyn_trace_span_get().
 *
 * The ring buffer wraps at AACYN_TRACE_MAX_SPANS. TypeScript should
 * track its own last-read count to only read new spans.
 */

uint32_t aacyn_trace_span_count(void) { return g_trace_span_count; }

int aacyn_trace_span_get(uint32_t idx, void *out_buf) {
  if (!out_buf)
    return 0;
  aacyn_trace_span_t *span = &g_trace_spans[idx % AACYN_TRACE_MAX_SPANS];
  memcpy(out_buf, span, sizeof(aacyn_trace_span_t));
  return 1;
}

#else
/* ── macOS/Other: Graceful stubs ────────────────────────────────────────── */

int aacyn_ebpf_attach(aacyn_store_t *store, const char *bpf_obj_path) {
  (void)store;
  (void)bpf_obj_path;
  return -99; /* eBPF not available on this platform */
}

int aacyn_ebpf_poll(int timeout_ms) {
  (void)timeout_ms;
  return 0;
}

void aacyn_ebpf_detach(void) { /* no-op */ }

uint64_t aacyn_ebpf_drain_count(void) { return 0; }

void aacyn_get_drop_counts(uint64_t *standard_drops, uint64_t *critical_drops) {
  *standard_drops = 0;
  *critical_drops = 0;
}

uint32_t aacyn_topology_count(void) { return 0; }

int aacyn_topology_get(uint32_t index, void *out_buf) {
  (void)index;
  (void)out_buf;
  return 0;
}

uint32_t aacyn_trace_span_count(void) { return 0; }

int aacyn_trace_span_get(uint32_t idx, void *out_buf) {
  (void)idx;
  (void)out_buf;
  return 0;
}

#endif /* AACYN_HAS_LIBBPF */

/* ─── Service Auto-Discovery Registry ────────────────────────────────────── */
/*
 * Maps eBPF-discovered PIDs to human-readable service records.
 * Each service tracks golden signals: accept rate, p99 latency, error count.
 *
 * The registry is populated by:
 *   - eBPF accept4 tracepoints (aacyn_auto.bpf.c)
 *   - Direct registration via aacyn_discovery_register()
 *
 * The TypeScript layer polls this registry to serve GET /v1/services.
 */

#define AACYN_MAX_SERVICES 256

typedef struct {
  uint32_t pid;            /* Process ID */
  uint16_t port;           /* Listening port */
  char comm[16];           /* Process name (from task_comm) */
  uint64_t accept_count;   /* Total accepted connections */
  uint64_t total_latency;  /* Cumulative accept latency in nanoseconds */
  uint64_t last_seen_ns;   /* Last activity timestamp (monotonic ns) */
  uint8_t active;          /* 1 if slot is occupied */
  uint8_t _pad[7];
} aacyn_service_t;

_Static_assert(sizeof(aacyn_service_t) == 56,
               "ServiceRecord must be exactly 56 bytes (matches TS RECORD_SIZE)");

static aacyn_service_t g_services[AACYN_MAX_SERVICES];
static uint32_t g_service_count = 0;

/*
 * Find or create a service entry by PID.
 * Returns pointer to the service slot, or NULL if registry is full.
 */
static aacyn_service_t *find_or_create_service(uint32_t pid) {
  /* Search for existing entry */
  for (uint32_t i = 0; i < g_service_count; i++) {
    if (g_services[i].active && g_services[i].pid == pid) {
      return &g_services[i];
    }
  }
  /* Create new entry */
  if (g_service_count >= AACYN_MAX_SERVICES) {
    return NULL;
  }
  aacyn_service_t *svc = &g_services[g_service_count++];
  memset(svc, 0, sizeof(*svc));
  svc->pid = pid;
  svc->active = 1;
  return svc;
}

/*
 * Register a discovered service (called from eBPF event handler
 * or directly from TypeScript).
 */
void aacyn_discovery_register(uint32_t pid, uint16_t port,
                              const char *comm, uint64_t latency_ns) {
  aacyn_service_t *svc = find_or_create_service(pid);
  if (!svc) return;

  svc->port = port;
  if (comm) {
    strncpy(svc->comm, comm, 15);
    svc->comm[15] = '\0';
  }
  svc->accept_count++;
  svc->total_latency += latency_ns;
  svc->last_seen_ns = latency_ns; /* Use as approximate timestamp */
}

/*
 * Get the number of discovered services.
 */
uint32_t aacyn_discovery_count(void) {
  return g_service_count;
}

/*
 * Get a service record by index.
 * Writes the service data into the provided buffer (sizeof(aacyn_service_t)).
 * Returns 1 on success, 0 if index is out of range.
 */
int aacyn_discovery_get(uint32_t index, void *out_buf) {
  if (index >= g_service_count || !out_buf)
    return 0;
  memcpy(out_buf, &g_services[index], sizeof(aacyn_service_t));
  return 1;
}

/* ─── Cleanup ────────────────────────────────────────────────────────────── */

void aacyn_store_destroy(aacyn_store_t *store) {
  if (!store)
    return;

  /* Double-destroy detection: if nulled out already, no-op */
  if (store->capacity == 0 && !store->timestamps && !store->mmap_base)
    return;

  if (store->mmap_base) {
    /* File-backed: sync, unmap, close */
    int rc = msync(store->mmap_base, store->mmap_size, MS_SYNC);
    if (rc != 0) {
      fprintf(stderr, "[libaacyn] msync failed during destroy: %s\n", strerror(errno));
    }
    munmap(store->mmap_base, store->mmap_size);
    if (store->fd >= 0)
      close(store->fd);
  } else {
    /* Anonymous-memory: free page-aligned regions */
    page_free(store->timestamps, store->capacity * sizeof(uint64_t), store->ts_is_mmap);
    page_free(store->durations, store->capacity * sizeof(float), store->dur_is_mmap);
    page_free(store->is_errors, store->capacity * sizeof(uint8_t), store->err_is_mmap);
  }

  /* Null all pointers to prevent use-after-free and detect double-destroy */
  store->timestamps = NULL;
  store->durations = NULL;
  store->is_errors = NULL;
  store->mmap_base = NULL;
  store->header = NULL;
  store->len = 0;
  store->capacity = 0;
  free(store);
}
