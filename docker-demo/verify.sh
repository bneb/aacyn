#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# verify.sh — Full aacyn sidecar verification pipeline
#
# Usage:  ./verify.sh          (full pipeline: test + build + deploy + check)
#         ./verify.sh --quick  (skip rebuild, just fire traffic + check)
#
# Runs tests, builds with --no-cache, deploys, fires traffic through
# nginx→node→postgres, and validates the /v1/topology API response
# including Golden Signals computation.
#
# Results are written to /tmp/aacyn_verify_results.txt
# ─────────────────────────────────────────────────────────────────────────────
set -e

RESULTS=/tmp/aacyn_verify_results.txt
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== aacyn Sidecar Verification ===" > "$RESULTS"
echo "Started: $(date)" >> "$RESULTS"

QUICK=false
if [ "$1" = "--quick" ]; then QUICK=true; fi

# ── Step 1: Tests ────────────────────────────────────────────────────────────
echo "[1/6] Running test suite..."
cd "$PROJECT_ROOT/ts/apps/api"
bun test 2>&1 | tail -5 >> "$RESULTS"
TEST_EXIT=$?
echo "Test exit: $TEST_EXIT" >> "$RESULTS"
if [ $TEST_EXIT -ne 0 ]; then
  echo "FAIL: Tests did not pass" >> "$RESULTS"
  cat "$RESULTS"; exit 1
fi
echo "[1/6] Tests passed"

if [ "$QUICK" = true ]; then
  echo "[2-4] Skipped (--quick mode)" >> "$RESULTS"
  echo "[2-4] Skipped (--quick mode)"
else
  # ── Step 2: Tear down ───────────────────────────────────────────────────
  echo "[2/6] Tearing down existing stack..."
  cd "$SCRIPT_DIR"
  docker compose down -v 2>&1 | tail -3
  echo "Stack torn down" >> "$RESULTS"

  # ── Step 3: Build with --no-cache ──────────────────────────────────────
  echo "[3/6] Building sidecar (--no-cache, ~60s)..."
  docker compose build --no-cache aacyn-sidecar 2>&1 | tail -3 >> "$RESULTS"
  BUILD_EXIT=$?
  echo "Build exit: $BUILD_EXIT" >> "$RESULTS"
  if [ $BUILD_EXIT -ne 0 ]; then
    echo "FAIL: Docker build failed" >> "$RESULTS"
    cat "$RESULTS"; exit 1
  fi
  echo "[3/6] Build succeeded"

  # ── Step 4: Boot full stack ────────────────────────────────────────────
  echo "[4/6] Booting full stack..."
  docker compose up -d 2>&1 | tail -6
  echo "" >> "$RESULTS"
  echo "=== Waiting 20s for eBPF attach ===" >> "$RESULTS"
  echo "[4/6] Waiting 20s for eBPF attach..."
  sleep 20

  # Check sidecar logs
  echo "" >> "$RESULTS"
  echo "=== Sidecar Logs ===" >> "$RESULTS"
  docker logs docker-demo-aacyn-sidecar-1 2>&1 \
    | grep -E "V2|standard|critical|failed|BTF|ERROR|Probes" \
    | head -5 >> "$RESULTS"
fi

# ── Step 5: Fire traffic ─────────────────────────────────────────────────
echo "[5/6] Firing 20 requests through nginx→node→postgres..."
for i in $(seq 1 20); do
  curl -sf -o /dev/null -H "Connection: close" http://localhost:8080/api/healthcheck 2>/dev/null
  sleep 0.2
done
echo "20 requests fired" >> "$RESULTS"
sleep 3

# ── Step 6: Check Golden Signals ─────────────────────────────────────────
echo "[6/6] Checking golden_signals in API response..."
echo "" >> "$RESULTS"
echo "=== /v1/topology Response ===" >> "$RESULTS"
curl -sf http://localhost:3001/v1/topology 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('Edges:', len(d.get('edges',[])))
print('Total eBPF events:', d.get('total_ebpf_events',0))
print('Uptime:', d.get('uptime_seconds','?'), 'seconds')
print('Drops:', d.get('drops'))
print()
gs=d.get('golden_signals',[])
print('Golden Signals:', len(gs), 'services')
for s in gs:
    print(f\"  {s['service']:20s}  {s['rate_rps']:.2f} req/s  {s['error_pct']:.2f}% err  {s['avg_latency_ms']:.1f} ms  {s['throughput_kbps']:.1f} KB/s\")
print()
has_bytes = any(e.get('bytes_transferred',0) > 0 for e in d.get('edges',[]))
print('bytes_transferred populated:', has_bytes)
for e in d.get('edges',[]):
    print(f\"  {e['source']:12s} -> {e['target']:20s}  hits={e['hit_count']}  bytes={e.get('bytes_transferred',0)}  errs={e.get('error_count',0)}\")
print()
if len(gs) > 0:
    print('RESULT: PASS')
elif len(d.get('edges',[])) > 0:
    print('RESULT: PARTIAL (edges exist but golden_signals empty)')
else:
    print('RESULT: FAIL (no edges detected)')
" >> "$RESULTS" 2>&1

echo "" >> "$RESULTS"
echo "Finished: $(date)" >> "$RESULTS"

echo ""
echo "─────────────────────────────────────────"
cat "$RESULTS"
echo "─────────────────────────────────────────"
