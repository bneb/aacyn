# aacyn Docker Demo — V2 eBPF Verification Protocol

## Prerequisites

- Docker Desktop (macOS or Windows with WSL 2)
- Docker Compose v2
- At least 4GB RAM allocated to Docker Desktop

## Step 1: Build and Boot the Stack

```bash
cd docker-demo
docker compose up --build -d
```

Expected output:
```
✔ Container docker-demo-db-1              Started
✔ Container docker-demo-api-1             Started
✔ Container docker-demo-frontend-1        Started
✔ Container docker-demo-aacyn-sidecar-1   Started
```

## Step 2: Verify the Victim Stack

```bash
# Frontend serves static page via Nginx
curl -s http://localhost:8080/ | head -5

# API responds through Nginx reverse proxy
curl -s http://localhost:8080/api/healthcheck | jq .
# Expected: {"status":"ok","latency_ms":31,"path":"/healthcheck"}
```

## Step 3: Verify V2 eBPF Probes Attached

```bash
# Check sidecar logs (wait ~15 seconds after boot)
docker logs docker-demo-aacyn-sidecar-1 2>&1 | grep -E "V2|standard|critical|drop"

# Expected:
# [libaacyn] V2 eBPF probes attached: /opt/aacyn/lib/aacyn_probes.bpf.o
#   standard_events (256KB) + critical_errors (64KB) + drop_counters (Per-CPU)
```

If you see `[eBPF] No BPF object found`, the path is wrong. Check that the build included `make EBPF=1`.

## Step 4: Generate Traffic

```bash
# Simple approach: 20 requests through nginx → node → postgres
for i in $(seq 1 20); do
  curl -sf -o /dev/null -H "Connection: close" http://localhost:8080/api/healthcheck
  sleep 0.2
done
echo "20 requests fired"

# Or use the test script:
bash test-traffic.sh 5
```

## Step 5: Verify Topology Merge (Connected Graph)

```bash
curl -sf http://localhost:3001/v1/topology | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('=== TOPOLOGY EDGES ===')
for e in d['edges']:
    print(f\"  {e['source']} -> {e['target']} ({e['hit_count']} hits)\")
print(f\"\\ndrops: {d.get('drops')}\")
print(f\"total events: {d.get('total_ebpf_events')}\")
"
```

**Expected:**
```
=== TOPOLOGY EDGES ===
  nginx -> node (20 hits)           ← merged (was "api (node)")
  node -> db (postgres) (20 hits)   ← connected subgraph
  curl -> aacyn-sidecar (N hits)
  node -> 127.0.0.1:65535 (20 hits)

drops: {'standard': 0, 'critical': 0}
```

**Key verification:** `nginx → node` (NOT `nginx → api (node)`) — this proves the BPF source_ip tracking is working and the IP-based merge is connecting the subgraphs.

## Step 6: Verify Observable Backpressure

```bash
# Verify drops are zero under normal load
curl -sf http://localhost:3001/v1/topology | python3 -c "
import json,sys
d=json.load(sys.stdin)
drops=d.get('drops',{})
std=drops.get('standard',0)
crit=drops.get('critical',0)
color='GREEN' if std+crit==0 else 'RED'
print(f'Drops: {std} standard, {crit} critical — {color}')
"
# Expected: Drops: 0 standard, 0 critical — GREEN
```

## Step 7: Open the Dashboard

Open **http://localhost:3000/dashboard** in any modern browser.

You should see:
- **Header HUD**: eBPF events count, edges, nodes, drops (green = 0)
- **Topology graph**: Canvas 2D force-directed graph with animated edges
- **Evidence panel**: Raw edge data with source/dest IPs and latencies
- **Time series**: Stacked bar chart of events/second by type

## Rebuilding After Code Changes

```bash
cd docker-demo
# Build with --no-cache to ensure all layers rebuild
docker compose build --no-cache aacyn-sidecar
docker compose up -d --force-recreate aacyn-sidecar
# Wait ~15 seconds for eBPF attach
```

## Cleanup

```bash
docker compose down -v
```

## Troubleshooting

### "V2 eBPF probes attached" not appearing
The BPF object may have failed to compile. Check the build log:
```bash
docker compose build --no-cache aacyn-sidecar > /tmp/build.log 2>&1
grep -E "error:|BPF" /tmp/build.log
```

### Disconnected subgraphs (3+ components)
The source_ip tracking is failing. Check if `skc_rcv_saddr` returns 0:
```bash
curl -sf http://localhost:3001/v1/topology | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d['edges']:
    print(f\"  {e['source']} -> {e['target']}  dest_ip={e.get('dest_ip','?')}\")
"
```
If all source_ips are `0.0.0.0`, the CO-RE relocation for `skc_rcv_saddr` failed against this kernel's BTF. Check BTF availability: `docker exec docker-demo-aacyn-sidecar-1 ls /sys/kernel/btf/vmlinux`.

### Dashboard shows 0 events after traffic
eBPF may have detached. Restart the sidecar:
```bash
docker compose up -d --force-recreate aacyn-sidecar
```
