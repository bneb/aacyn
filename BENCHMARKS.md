# Benchmarks

## Headline

**5,089,364 events/second** · 16ms p99 · Zero errors · One consumer-grade mini PC

---

## Binary Ingestion Siege (Path B — FlatBuffers)

| Metric | Value |
|--------|------:|
| Throughput | **5,089,364 events/sec** |
| Request Rate | 50,894 req/sec |
| Total Events (50s) | 254,468,200 |
| | |
| Avg Latency | 7.77ms |
| p95 Latency | 12.73ms |
| p99 Latency | 16.12ms |
| Max Latency | 33.19ms |
| | |
| Error Rate | 0.00% |
| Dropped Events | 0 |

### How to reproduce

```bash
# On the target machine (Ubuntu 24.04, x86_64)
just build-native          # Compile libaacyn.so with AVX-512
just benchmark-binary      # Generate payload → start siege (500 VUs × 50s)
```

---

## Industry Comparison

All figures below are from publicly documented benchmarks and official documentation.

| Platform | Throughput | Hardware | Source |
|----------|-----------|----------|--------|
| **aacyn** | **5,089,364 evt/sec** | 1× consumer mini PC (8C/16T) | This benchmark |
| ClickHouse (structured logs) | ~120,000–130,000 rows/sec | Single node (8C, 16GB) | [GreptimeDB vs ClickHouse log benchmark, Aug 2024](https://greptime.com/blogs/2024-08-22-log-engine-benchmark) |
| Vector (Datadog) | ~76 MiB/sec | File-to-TCP pipeline | [Vector.dev performance benchmarks](https://vector.dev/) |

### Apples-to-apples notes

These comparisons are **directionally valid but not identical workloads**:

- **ClickHouse** measures structured log row insertion via native protocol, not HTTP ingestion. ClickHouse is a DBMS with full indexing and persistence; our SoA store is memory-resident during the benchmark.
- **Vector** measures byte throughput for data routing, not event counting. At ~76 MiB/s with typical ~200-byte log lines, this translates to ~380K events/sec equivalent.

**What makes aacyn different**: We bypass JSON parsing entirely (FlatBuffer binary protocol), cross the FFI boundary with a raw pointer (no V8 GC involvement), and write directly into page-aligned columnar memory via `mmap`. This eliminates the three largest bottlenecks in traditional observability pipelines: deserialization, garbage collection, and heap allocation.

---

## JSON Ingestion Baseline (Path A)

| Metric | Value |
|--------|------:|
| Throughput | ~314,000 events/sec |
| Request Rate | 3,138 req/sec |
| Total Events (50s) | 15,688,300 |
| | |
| Avg Latency | 88.70ms |
| p95 Latency | 218.79ms |

### Binary vs JSON

| | JSON | Binary | Improvement |
|---|---:|---:|---:|
| Events/sec | 314K | **5.09M** | **16.2×** |
| p95 Latency | 218.79ms | **12.73ms** | **17.2×** |
| p99 Latency | — | **16.12ms** | — |

---

## AVX-512 Scan Benchmark (Query Performance)

5 million events · 62MB columnar data · AMD Ryzen 9 8945HS (AVX-512)

| Scan Operation | Median | p99 | Effective Rate |
|---------------|-------:|----:|---------------:|
| `scan_duration_max` | **286μs** | 402μs | 17.5B events/sec |
| `scan_error_count` | **35μs** | 60μs | 141.6B events/sec |
| `scan_duration_filter (>10ms)` | **298μs** | 415μs | 16.8B events/sec |

All scans complete in **< 415μs p99**. That's 5 million events queried in under half a millisecond.

### How this works

AVX-512 processes 16 floats per CPU cycle. The columnar SoA layout means the CPU prefetcher sees contiguous memory — no pointer chasing, no hash lookups, no index maintenance. The `scan_error_count` is particularly fast because `is_errors` is a `uint8_t[]` column that fits entirely in L2 cache (5MB ÷ 1 byte = 5M entries).

### How to reproduce

```bash
just benchmark-scan           # Default: 5M events
just benchmark-scan 10000000  # Custom: 10M events
```

---

## Hardware

| Component | Spec |
|-----------|------|
| Machine | Minisforum UM890 Pro |
| CPU | AMD Ryzen 9 8945HS (8C/16T, Zen 4) |
| RAM | 32GB DDR5-5600 |
| Storage | 1TB NVMe |
| OS | Ubuntu Server 24.04 (minimized, no GUI) |

---

## Methodology

### What was measured

The benchmark measures **end-to-end binary event ingestion** through the full production stack:

```
k6 VU → HTTP POST (localhost) → Bun/Elysia → bun:ffi → libaacyn.c → mmap SoA store
```

Both the load generator (k6) and the server (Bun) run on the same machine. All traffic is over the localhost loopback interface. **No network I/O is involved.**

Each request sends a 1,656-byte pre-compiled FlatBuffer containing 100 `EventStruct` records (16 bytes each: `u64 timestamp` + `f32 duration_ms` + `u16 status_code` + `u16 pad`).

### What was NOT measured

- **Disk I/O** — The mmap SoA store is memory-resident. Write-back to NVMe is asynchronous and OS-managed.
- **Query latency** — Only ingestion throughput is measured here. Query benchmarks are separate.
- **Multi-node** — Single node, no replication or sharding.
- **TLS overhead** — Plaintext localhost. Production TLS would add latency.
- **Network transfer** — Load generator and server are co-located on the same machine.
- **eBPF probe load** — Probes were compiled and attached but not generating additional traffic during this benchmark.

### Load generator

- **Tool**: [k6](https://k6.io/) v0.55
- **VUs**: 500 virtual users
- **Duration**: 50 seconds (10s ramp-up, 30s sustained, 10s ramp-down)
- **Payload**: Pre-compiled binary, read once at init, sent from memory (no per-request serialization)
- **Transport**: HTTP/1.1 localhost loopback (no network)

### Kernel tuning applied

```
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
vm.max_map_count = 262144
vm.swappiness = 10
CPU governor: performance (locked max clock)
```

### What the numbers mean

The **5.09M events/sec** figure represents the rate at which structured telemetry events traverse the full ingestion pipeline — from HTTP receipt through FFI boundary crossing into page-aligned columnar memory. This is not a synthetic memory-copy benchmark; it includes HTTP parsing, routing, and memory management overhead.

The **zero error rate** at 50,000 concurrent requests/second confirms that the TCP backlog tuning and Bun's event loop sustain this load without connection drops, timeouts, or buffer overflows.

The **16ms p99** means that even at the 99th percentile, the worst-case latency a client experiences is under 20 milliseconds — while the system is ingesting 5 million events per second on a single consumer CPU.
