#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# aacyn Docker Demo — Microservice Load Spike Generator
#
# Simulates a burst of traffic through the victim stack to flood the
# eBPF ring buffer with connect()/tcp_sendmsg events, proving the
# C engine can ingest kernel events without dropping frames.
#
# Topology:
#   test-traffic.sh → Nginx(:8080) → Node API(:3000) → Postgres(:5432)
#
# Each HTTP request forces 3 TCP connections:
#   1. curl → Nginx (port 8080)
#   2. Nginx → Node API (port 3000, Connection: close)
#   3. Node → Postgres (port 5432, fresh Client per request)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET="http://localhost:8080/api/healthcheck"
SIDECAR="http://localhost:3001"
WORKERS=50
DURATION_SECS=15

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}$1${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
info()   { echo -e "  ${YELLOW}→${NC} $1"; }

# ─── Phase 0: Pre-flight ────────────────────────────────────────────────────
header "[🔍] Phase 0 — Pre-flight Checks"

if ! curl -sf --max-time 3 "$TARGET" > /dev/null 2>&1; then
    fail "Victim stack not reachable at $TARGET"
    info "Run: docker compose up -d"
    exit 1
fi
ok "Victim stack reachable"

if ! curl -sf --max-time 3 "$SIDECAR/health" > /dev/null 2>&1; then
    fail "aacyn sidecar not reachable at $SIDECAR"
    exit 1
fi
ok "aacyn sidecar reachable"

# Capture baseline event count
BASELINE=$(curl -sf "$SIDECAR/v1/services" 2>/dev/null | grep -o '"count":[0-9]*' | head -1 | cut -d: -f2 || echo "0")
info "Baseline service count: $BASELINE"

# ─── Phase 1: Warm-up ───────────────────────────────────────────────────────
header "[🔥] Phase 1 — Warm-up (10 sequential requests)"

for i in $(seq 1 10); do
    STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -H "Connection: close" "$TARGET" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
        ok "Request $i/10 — HTTP $STATUS"
    else
        fail "Request $i/10 — HTTP $STATUS"
    fi
done

# ─── Phase 2: Load Spike ────────────────────────────────────────────────────
header "[⚡] Phase 2 — Sustained Load Spike ($WORKERS workers × ${DURATION_SECS}s)"
info "Generating maximum socket churn..."

TOTAL_FILE=$(mktemp)
echo "0" > "$TOTAL_FILE"

# Spawn concurrent workers
for w in $(seq 1 $WORKERS); do
    (
        COUNT=0
        END=$((SECONDS + DURATION_SECS))
        while [ $SECONDS -lt $END ]; do
            curl -sf -o /dev/null -H "Connection: close" "$TARGET" 2>/dev/null && COUNT=$((COUNT + 1)) || true
        done
        # Atomic-ish append
        echo "$COUNT" >> "$TOTAL_FILE"
    ) &
done

# Progress indicator
echo -ne "  "
ELAPSED=0
while [ $ELAPSED -lt $DURATION_SECS ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
    ACTIVE=$(jobs -r | wc -l | tr -d ' ')
    echo -ne "\r  ${YELLOW}⏱${NC}  ${ELAPSED}/${DURATION_SECS}s  (${ACTIVE} workers active)    "
done
echo ""

# Wait for all workers
wait 2>/dev/null

# Sum up total requests
TOTAL=0
while IFS= read -r line; do
    if [ -n "$line" ] && [ "$line" -gt 0 ] 2>/dev/null; then
        TOTAL=$((TOTAL + line))
    fi
done < "$TOTAL_FILE"
rm -f "$TOTAL_FILE"

ok "Load spike complete: ${BOLD}$TOTAL${NC}${GREEN} total HTTP requests${NC}"
info "→ Each request generated ~3 TCP connections = ~$((TOTAL * 3)) connect() syscalls"

# ─── Phase 3: Harvest ───────────────────────────────────────────────────────
header "[📊] Phase 3 — Harvest (querying aacyn sidecar)"
sleep 2  # Let the ring buffer drain

# Query discovered services
echo ""
info "GET /v1/services:"
SERVICES=$(curl -sf "$SIDECAR/v1/services" 2>/dev/null || echo '{"error":"unreachable"}')
echo "$SERVICES" | python3 -m json.tool 2>/dev/null || echo "  $SERVICES"

# Query topology
echo ""
info "GET /v1/topology:"
TOPOLOGY=$(curl -sf "$SIDECAR/v1/topology" 2>/dev/null || echo '{"error":"not implemented yet"}')
echo "$TOPOLOGY" | python3 -m json.tool 2>/dev/null || echo "  $TOPOLOGY"

# Query event count from store
echo ""
info "GET /v1/metrics:"
EVENTS=$(curl -sf "$SIDECAR/v1/metrics" 2>/dev/null || echo '{"error":"unreachable"}')
echo "$EVENTS" | python3 -m json.tool 2>/dev/null || echo "  $EVENTS"

# ─── Summary ─────────────────────────────────────────────────────────────────
header "[🎯] Demo Summary"
echo -e "  ${BOLD}Requests sent:${NC}    $TOTAL"
echo -e "  ${BOLD}TCP connections:${NC}  ~$((TOTAL * 3))"
echo -e "  ${BOLD}Workers:${NC}          $WORKERS concurrent"
echo -e "  ${BOLD}Duration:${NC}         ${DURATION_SECS}s"
echo -e "  ${BOLD}Dashboard:${NC}        ${CYAN}http://localhost:3000/dashboard${NC}"
echo ""
