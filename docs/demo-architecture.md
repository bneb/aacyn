# aacyn Demo — Architecture & Design Decisions

> This document describes how the demo works and explains the key design decisions behind the architecture.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Demo Stack Layout](#demo-stack-layout)
3. [Design Decisions](#design-decisions)
4. [End-to-End Data Flow](#end-to-end-data-flow)
5. [Running the Demo](#running-the-demo)

---

## System Overview

aacyn is a **zero-instrumentation observability engine**. It attaches eBPF probes to the Linux kernel to intercept network syscalls and automatically discovers the microservice topology — without installing agents, SDKs, or modifying application code.

The demo runs 4 Docker containers:

```
┌───────────────────────────────────────────────────┐
│ Docker Bridge Network (172.18.0.0/16)             │
│                                                   │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐   │
│  │ frontend │────▶│   api    │────▶│    db    │   │
│  │  nginx   │     │ node:20  │     │ postgres │   │
│  │  :80     │     │  :3000   │     │  :5432   │   │
│  └──────────┘     └──────────┘     └──────────┘   │
│       ▲                                           │
│       │ port 8080                                 │
│                                                   │
│  ┌──────────────────────────────────────────┐     │
│  │  aacyn-sidecar (privileged, pid:host)    │     │
│  │  eBPF probes instrument kernel syscalls  │     │
│  │  API server at :3001                     │     │
│  └──────────────────────────────────────────┘     │
└───────────────────────────────────────────────────┘
```

**Key insight:** The victim services (nginx, node, postgres) have **zero observability configuration**. No OpenTelemetry. No Datadog agent. No log shippers. aacyn discovers them by observing their kernel-level behavior.

---

## Demo Stack Layout

| Container | Image | Port | Role | aacyn Relevance |
|-----------|-------|------|------|-----------------|
| `frontend` | `nginx:alpine` | 8080→80 | Reverse proxy | Generates `connect()` syscalls to `api:3000` |
| `api` | `node:20-alpine` | — | REST API | Creates fresh Postgres connections per request (deliberate — maximizes eBPF events) |
| `db` | `postgres:15-alpine` | — | Database | Accepts connections from `api` |
| `aacyn-sidecar` | Custom (Dockerfile.aacyn) | 3001, 4318 | eBPF engine + API server | Intercepts all network syscalls across all containers |

### Why `privileged: true` and `pid: host`?
eBPF requires `CAP_BPF` (or root). `pid: host` gives the sidecar visibility into all container processes — it can read `/proc/<pid>/comm` to learn process names.

### Why does the API create a new Postgres connection per request?
Deliberate design for the demo. Each HTTP request generates:
- `nginx connect() → api:3000` (1 event)
- `api connect() → db:5432` (1 event)
- `postgres accept()` (1 discovery event)
- Multiple `tcp_sendmsg()` events

Connection pooling would reduce this to just `tcp_sendmsg()` after warmup, making the demo less impressive visually.

---

## Design Decisions

Each decision below explains the rationale behind the approach and the tradeoffs considered.

---

### Decision 1: BPF_MAP_TYPE_RINGBUF over BPF_MAP_TYPE_PERF_EVENT_ARRAY

**What we did:** Use `BPF_MAP_TYPE_RINGBUF` for event transport from kernel to user-space.

**Rationale:**
- `PERF_EVENT_ARRAY` allocates **per-CPU buffers** (N copies of the buffer). On a 96-core server, a 256KB buffer becomes 24MB of wasted memory.
- `RINGBUF` is a **shared buffer** — all CPUs write to one 256KB allocation. Memory-efficient.
- `RINGBUF` doesn't require per-CPU wakeups. The `ring_buffer__poll()` API in user-space drains all events from all CPUs in one call.

---

### Decision 2: Dual Ring Buffers with Priority Routing

**What we did:** Two separate ring buffers: `standard_events` (256KB) and `critical_errors` (64KB).

**Rationale:**
- Under extreme load (50K connections/sec), a single buffer saturates. Standard telemetry (connect, send) drowns out critical errors (connection failures, timeouts).
- Separating buffers ensures critical errors are **never overwritten by noise**. The critical buffer is smaller (64KB) because error events are rare — but when they do occur, they must not be lost.

---

### Decision 3: BPF_MAP_TYPE_PERCPU_ARRAY for Drop Counters

**What we did:** A `PERCPU_ARRAY` with 2 keys (standard drops, critical drops) to count events dropped due to buffer saturation.

**Rationale:**
- When a ring buffer is full, `bpf_ringbuf_reserve()` returns NULL. We must count this — it's the backpressure signal.
- A regular array would require `bpf_spin_lock` or `__sync_fetch_and_add` on a shared counter — cache-line bouncing under load.
- `PERCPU_ARRAY` gives each CPU its own counter. Zero contention. User-space aggregates across CPUs when reading.

---

### Decision 4: Source IP via CO-RE Socket Introspection

**What we did:** In `trace_connect_exit`, we walk the task's file descriptor table to read the socket's local IPv4 address (`skc_rcv_saddr`).

**The walk:**
```
bpf_get_current_task()
  → task_struct.files
    → files_struct.fdt
      → fdtable.fd[saved_fd]
        → file.private_data  (cast to struct socket *)
          → socket.sk
            → sock.__sk_common.skc_rcv_saddr   ← container's bridge IP
```

**Rationale:**
- Each Docker container has a unique IP on the bridge network (e.g., `172.18.0.3`).
- `connect()` syscalls give us `dest_ip` but NOT `source_ip`. Without source_ip, we can't correlate that the process accepting connections on port 3000 is the same one making connections to port 5432.
- We stash the fd from `sys_enter_connect`, then in `sys_exit_connect` (after the socket is bound), we introspect the fd to get the local address.

---

### Decision 5: Hand-Crafted vmlinux.h (not bpftool-generated)

**What we did:** A ~200-line `vmlinux.h` with only the kernel types our probes actually use, instead of the ~150,000-line file generated by `bpftool btf dump`.

**Rationale:**
- Docker builds must be reproducible. A `bpftool`-generated vmlinux.h depends on the build machine's running kernel — different machines produce different files.
- Our hand-crafted version has the exact structs we need, marked with `__attribute__((preserve_access_index))` for CO-RE.
- CO-RE means: we compile against our minimal struct definitions, but libbpf resolves the actual field offsets at runtime from the host kernel's BTF. The struct field names must match, but the offsets don't need to.

---

### Decision 6: Canvas 2D Rendering (not D3.js/Cytoscape)

**What we did:** The topology map is rendered using the Canvas 2D API with a force-directed physics simulation, not a DOM-based charting library.

**Rationale:**
- D3.js creates thousands of SVG DOM elements for each topology edge. With 500ms polling, the garbage collector would cause visible jank.
- Canvas 2D draws directly to a bitmap buffer. No DOM nodes per element, no GC pressure, no reflow.
- The physics engine runs in requestAnimationFrame: Coulomb repulsion pushes nodes apart, Hooke spring forces pull connected nodes together, and velocity damping stabilizes the layout.

**Note:** The renderer currently uses Canvas 2D throughout. WebGPU rendering (via WGSL shaders) is under investigation as a future optimization — it would offload geometry to the GPU and further reduce CPU overhead on large topologies, but Canvas 2D comfortably handles the demo scale.

---

### Decision 7: IP-Based Topology Merge (not PID, not Port, not Label)

**What we did:** In the TypeScript enrichment layer, we build an `ipToSource` map from BPF-provided `source_ip` fields, then rename targets whose `dest_ip` matches a known source.

**Rationale (and rejected alternatives):**
- **Port-based merge** (rejected): Port 3000 could be used by multiple services. Docker containers can all internally listen on `3000`.
- **PID-based merge** (rejected): PIDs are transient and recycled. Container restart changes the PID.
- **Label/regex merge** (rejected): Parsing labels like `"api (node)"` to extract `"node"` is fragile and hardcodes the label format.
- **IP-based merge** (chosen): Container IPs are unique on the bridge network, stable for the container's lifetime, and provided directly by the kernel via `skc_rcv_saddr`.

---

## End-to-End Data Flow

Here is exactly what happens when you run `curl http://localhost:8080/api/healthcheck`:

```
1. curl → connect(172.18.0.5:80)  [nginx container]
   ├── BPF: trace_connect_enter fires
   │   └── Stashes fd + dest in connect_state map
   ├── BPF: trace_connect_exit fires
   │   ├── Reads source_ip via fd→socket→sock→skc_rcv_saddr
   │   ├── Emits network_event to standard_events ringbuf
   │   └── Event: {source_ip: 172.18.0.4, dest_ip: 172.18.0.5, port: 80, comm: "curl"}
   └── BPF: trace_tcp_sendmsg fires
       └── Reads source_ip + dest_ip from struct sock

2. nginx → connect(172.18.0.3:3000)  [node API container]
   └── Same BPF flow → Event: {source_ip: 172.18.0.5, dest_ip: 172.18.0.3, ...}

3. node → connect(172.18.0.2:5432)  [postgres container]
   └── Same BPF flow → Event: {source_ip: 172.18.0.3, dest_ip: 172.18.0.2, ...}

4. User-space consumer (libaacyn.so):
   ├── ring_buffer__poll() drains both standard_events + critical_errors
   ├── ebpf_event_handler() creates topology edges on connect-exit (status=1)
   └── Stores in columnar SoA (mmap'd)

5. TypeScript API (/v1/topology):
   ├── Reads topology edges via FFI
   ├── Builds ipToSource: {172.18.0.5→"nginx", 172.18.0.3→"node", ...}
   ├── Merges: "api (node)" → "node" (because dest_ip=172.18.0.3 maps to "node")
   └── Returns JSON: nginx→node→db (one connected subgraph)

6. Dashboard (Canvas 2D):
   ├── Fetches /v1/topology every 500ms
   ├── Force-directed layout positions nodes via physics simulation
   ├── Canvas 2D draws circles (nodes) and straight lines (edges)
   └── requestAnimationFrame drives smooth animation at display refresh rate
```

---

## Running the Demo

### Quick Start (3 commands)

```bash
cd docker-demo
docker compose up --build -d
# Wait ~20 seconds for eBPF to attach
bash test-traffic.sh 5
# Open http://localhost:3000 in Chrome (or http://localhost:3001/v1/dashboard/data for the raw API)
```

### Verifying eBPF is Active

```bash
# Check sidecar logs for V2 attach message
docker logs docker-demo-aacyn-sidecar-1 2>&1 | grep "V2 eBPF"
# Expected: [libaacyn] V2 eBPF probes attached: ... standard_events + critical_errors + drop_counters

# Check API returns drops field
curl -s http://localhost:3001/v1/topology | python3 -c "import json,sys; d=json.load(sys.stdin); print('drops:', d.get('drops')); print('edges:', len(d['edges']))"
# Expected: drops: {'standard': 0, 'critical': 0}  edges: 4+
```

### Verifying Topology Merge

```bash
# Fire traffic through nginx→node→postgres
for i in $(seq 1 10); do curl -sf -o /dev/null http://localhost:8080/api/healthcheck; sleep 0.2; done

# Check topology
curl -s http://localhost:3001/v1/topology | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d['edges']:
    print(f\"  {e['source']} -> {e['target']} ({e['hit_count']} hits)\")
"
# Expected: nginx -> node, node -> db (postgres) — NOT "api (node)"
```

### Rebuilding After Code Changes

```bash
cd docker-demo
docker compose build --no-cache aacyn-sidecar
docker compose up -d --force-recreate aacyn-sidecar
# Wait ~15 seconds for eBPF attach
```

### Cleanup

```bash
docker compose down -v
```

