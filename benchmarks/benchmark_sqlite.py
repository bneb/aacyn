#!/usr/bin/env python3
"""
benchmark_sqlite.py -- SQLite equivalent of the columnar-store benchmark.

Measures three operations against an in-memory SQLite database:
  1. Ingest throughput  -- INSERT N rows
  2. Scan throughput    -- SELECT MAX(duration)  (full table scan)
  3. Query latency      -- SELECT ... WHERE is_error = 1 (filtered scan)

Usage:
  python3 benchmark_sqlite.py              # 10M events (default)
  python3 benchmark_sqlite.py 5000000      # 5M events
  python3 benchmark_sqlite.py --quick      # 1M events (CI)

Output: JSON to stdout.
"""

import json
import sqlite3
import struct
import sys
import time


def generate_data(event_count: int):
    """Generate matching synthetic data as the C benchmark."""
    timestamps = bytearray(event_count * 8)
    durations = bytearray(event_count * 4)
    is_errors = bytearray(event_count)

    for i in range(event_count):
        struct.pack_into("<Q", timestamps, i * 8, i * 1000)  # 1 microsecond apart
        dur = 1.0 + float(i % 20) * 0.5  # cycling 1.0 .. 10.5
        struct.pack_into("<f", durations, i * 4, dur)
        is_errors[i] = 1 if (i % 19 == 0) else 0  # ~5.3% errors

    return timestamps, durations, is_errors


def run_benchmark(event_count: int) -> dict:
    # Generate data
    ts_bytes, dur_bytes, err_bytes = generate_data(event_count)

    # Unpack into Python list of tuples for executemany
    rows = []
    for i in range(event_count):
        ts = struct.unpack_from("<Q", ts_bytes, i * 8)[0]
        dur = struct.unpack_from("<f", dur_bytes, i * 4)[0]
        err = err_bytes[i]
        rows.append((ts, dur, err))

    # -------------------------------------------------------------------
    #  BENCHMARK 1: Ingest throughput
    # -------------------------------------------------------------------
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA journal_mode = MEMORY")
    conn.execute(
        "CREATE TABLE events (ts INTEGER, dur REAL, err INTEGER)"
    )

    # Batch INSERT in chunks of 100000 for efficiency
    batch_size = 100000
    t0 = time.perf_counter()
    for start in range(0, event_count, batch_size):
        chunk = rows[start : start + batch_size]
        conn.executemany(
            "INSERT INTO events (ts, dur, err) VALUES (?, ?, ?)", chunk
        )
    conn.commit()
    t1 = time.perf_counter()
    ingest_time = t1 - t0
    ingest_rate = event_count / ingest_time

    # Create index for fair comparison (the C store has O(1) column access)
    conn.execute("CREATE INDEX idx_events_err ON events(err)")
    conn.commit()

    # -------------------------------------------------------------------
    #  BENCHMARK 2: Full-table scan (MAX duration)
    # -------------------------------------------------------------------
    scan_iters = 100
    if event_count < 100000:
        scan_iters = 1000

    t0 = time.perf_counter()
    for _ in range(scan_iters):
        cur = conn.execute("SELECT MAX(dur) FROM events")
        _ = cur.fetchone()[0]
    t1 = time.perf_counter()

    scan_total = t1 - t0
    scan_avg_s = scan_total / scan_iters
    scan_rate = event_count / scan_avg_s

    # -------------------------------------------------------------------
    #  BENCHMARK 3: Error query (filtered scan)
    # -------------------------------------------------------------------
    query_iters = 100
    if event_count < 100000:
        query_iters = 1000

    t0 = time.perf_counter()
    total_found = 0
    for _ in range(query_iters):
        cur = conn.execute("SELECT ts, dur, err FROM events WHERE err = 1")
        found = 0
        for _ in cur:
            found += 1
        total_found = found
    t1 = time.perf_counter()

    query_total = t1 - t0
    query_avg_s = query_total / query_iters
    query_latency_ms = query_avg_s * 1000.0

    conn.close()

    return {
        "sqlite": {
            "ingest_events_per_sec": round(ingest_rate),
            "scan_events_per_sec": round(scan_rate),
            "error_query_latency_ms": round(query_latency_ms, 6),
            "events_inserted": event_count,
        }
    }


def main():
    event_count = 10_000_000

    for arg in sys.argv[1:]:
        if arg == "--quick":
            event_count = 1_000_000
        elif arg.startswith("--"):
            print(f"Unknown flag: {arg}", file=sys.stderr)
            sys.exit(1)
        else:
            event_count = int(arg)

    print(json.dumps(run_benchmark(event_count), indent=2))


if __name__ == "__main__":
    main()
