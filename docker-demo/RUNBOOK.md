# aacyn Demo Runbook

> Copy-paste these commands exactly. No thinking required.
> Tested on macOS with Docker Desktop.

---

## Prerequisites

- Docker Desktop running (at least 4GB RAM allocated)
- Any modern browser (Chrome, Firefox, Safari)
- Terminal in the aacyn repo root

---

## Step 1: Boot the Stack (30 seconds)

```bash
cd docker-demo
docker compose up --build -d
```

Wait for all 4 containers to start:
```
✔ Container docker-demo-db-1              Started
✔ Container docker-demo-api-1             Started
✔ Container docker-demo-frontend-1        Started
✔ Container docker-demo-aacyn-sidecar-1   Started
```

---

## Step 2: Wait for eBPF Attach (15 seconds)

```bash
sleep 15
```

The sidecar needs time to compile and attach BPF probes to the kernel.

---

## Step 3: Verify eBPF is Active

```bash
docker logs docker-demo-aacyn-sidecar-1 2>&1 | tail -10
```

Look for this line:
```
[libaacyn] V2 eBPF probes attached: /opt/aacyn/lib/aacyn_probes.bpf.o
  standard_events (256KB) + critical_errors (64KB) + drop_counters (Per-CPU)
```

If you see `No BPF object found` instead, rebuild: `docker compose build --no-cache aacyn-sidecar`

---

## Step 4: Generate Traffic

```bash
bash test-traffic.sh 5
```

This sends requests at 5 RPS through the full stack: `curl → nginx → node → postgres`.

Leave this running in the background, or run it for 10 seconds and stop.

For a quick burst instead:
```bash
for i in $(seq 1 20); do curl -sf -o /dev/null http://localhost:8080/api/healthcheck; sleep 0.2; done
```

---

## Step 5: Open the Dashboard

```bash
open http://localhost:3000/dashboard
```

Or paste into your browser: **http://localhost:3000/dashboard**

You should see:
- **Top bar**: eBPF event count, edges, nodes, drops (green = 0)
- **Center**: Canvas 2D topology graph with animated particle edges
- **Right panel**: Raw eBPF evidence with IPs, hit counts, latencies
- **Bottom**: Time series chart (events/second, stacked by type)

The graph should show: **nginx → node → db (postgres)** as one connected chain.

---

## Step 6: Interact with the Dashboard

Click **"Fire Request → Watch Counters"** in the evidence panel to send a request and watch the counters increment in real time.

---

## Cleanup

```bash
docker compose down -v
```

---

## Quick Reference

| URL | What |
|-----|------|
| http://localhost:8080/ | Frontend (nginx static page) |
| http://localhost:8080/api/healthcheck | API through nginx proxy |
| http://localhost:3000/dashboard | aacyn dashboard |
| http://localhost:3001/v1/topology | Raw topology JSON |
| http://localhost:3001/v1/services | Discovered services JSON |
| http://localhost:3001/health | aacyn API health |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard shows 0 events | Wait 15s for eBPF attach, then send traffic |
| Graph shows disconnected nodes | Rebuild sidecar: `docker compose build --no-cache aacyn-sidecar && docker compose up -d --force-recreate aacyn-sidecar` |
| Dashboard won't load | Verify the Next.js app is running: `docker logs docker-demo-api-1` |
| Container won't start | Check Docker Desktop has 4GB+ RAM |
| `test-traffic.sh` errors | Verify API works: `curl http://localhost:8080/api/healthcheck` |
