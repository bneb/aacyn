# aacyn Docker Demo — Zero-Instrumentation eBPF Observability

A self-contained Docker Compose environment that demonstrates aacyn's kernel-level topology discovery. Four containers run a toy microservice stack (nginx → node → postgres) with **zero telemetry configuration**. The aacyn sidecar attaches eBPF probes to the Linux kernel and automatically discovers the service graph.

```
curl ──▶ nginx:80 ──▶ node:3000 ──▶ postgres:5432
              │
              │  (all observed by)
              ▼
         aacyn-sidecar (eBPF, privileged, pid:host)
         └─ Dashboard: http://localhost:3000/dashboard
```

## Quick Start

```bash
docker compose up --build -d        # boot all 4 containers
sleep 15                            # wait for eBPF attach
bash test-traffic.sh 5              # generate requests
open http://localhost:3000/dashboard # view topology
```

## Directory Contents

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Orchestrates all 4 services on a shared bridge network |
| `Dockerfile.aacyn` | Multi-stage build: compiles BPF object + native C lib + Bun API |
| `aacyn-entrypoint.sh` | Boot script: mounts debugfs/tracefs, verifies tracepoints, starts engine |
| `nginx.conf` | Reverse proxy config: `/` → static, `/api/*` → node:3000 |
| `test-traffic.sh` | Traffic generator with configurable RPS and duration |
| `.env` | Runtime config (AACYN_MODE, optional forwarder keys) |
| `VERIFICATION.md` | Step-by-step verification protocol with troubleshooting |
| `README.md` | This file |
| `sdk/` | Shared TypeScript types (`@aacyn/sdk` package) |

## Architecture

### The Victims (zero instrumentation)

| Service | Image | Listens On | Notes |
|---------|-------|------------|-------|
| **frontend** | `nginx:alpine` | `:80` (exposed as `:8080`) | Static files + reverse proxy to `api:3000` |
| **api** | `node:20-alpine` | `:3000` | REST endpoint, fresh Postgres connection per request |
| **db** | `postgres:15-alpine` | `:5432` | Trust auth, no config needed |

### The Predator (aacyn sidecar)

| Property | Value | Why |
|----------|-------|-----|
| `privileged: true` | Required | eBPF needs `CAP_BPF` for probe attachment |
| `pid: host` | Required | Read `/proc/<pid>/comm` across all containers |
| `/sys/kernel/debug` mount | Required | Tracepoint access (`sys_enter_connect`, etc.) |
| `/sys/kernel/tracing` mount | Required | Kprobe attachment (`tcp_sendmsg`) |

### V2 eBPF Engine

The sidecar runs the V2 dual-ring-buffer architecture:

- **`standard_events`** (256KB) — normal connects, sends
- **`critical_errors`** (64KB) — failed connects, timeouts
- **`drop_counters`** (Per-CPU array) — observable backpressure
- **Source IP tracking** — `skc_rcv_saddr` via CO-RE socket introspection for topology merge

### Network

All containers share a Docker bridge network (`demo`). Each gets a unique IP (e.g., `172.18.0.2–5`). The aacyn sidecar reads these IPs from BPF socket introspection to merge disconnected topology subgraphs.

## Key Files Outside This Directory

| File | Location | Relevance |
|------|----------|-----------|
| `native/aacyn_probes.bpf.c` | BPF kernel probes (V2 dual buffers + source_ip) |
| `native/libaacyn.c` | User-space C engine (ring buffer consumer, topology tracker) |
| `native/vmlinux.h` | Hand-crafted CO-RE type definitions |
| `native/Makefile` | Build system (`make EBPF=1` compiles BPF object) |
| `ts/apps/api/src/lib/native-store.ts` | FFI bindings + IP-based topology merge |
| `ts/apps/api/src/lib/native-store.ts` | FFI bindings + IP-based topology merge |
| `ts/apps/api/src/routes/dashboard.ts` | Dashboard data API endpoint |
| `ts/apps/api/src/routes/discovery.ts` | `/v1/topology` API route |
| `docs/ebpf.md` | eBPF architecture documentation |

## Cleanup

```bash
docker compose down -v
```
