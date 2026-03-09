#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# aacyn Docker Demo — Traffic Generator
#
# Simulates a 5-service microservices cluster to generate TCP connections
# visible to the aacyn eBPF engine.
#
# Services:
#   api-gateway         → frontend (HTTP ingress)
#   auth-service        → /api/healthcheck?src=auth-service
#   payment-service     → /api/healthcheck?src=payment-service
#                         (depends on inventory + notification)
#   inventory-service   → /api/healthcheck?src=inventory-service
#   notification-service → /api/healthcheck?src=notification-service
#
# Traffic Patterns:
#   Normal:  ~200 req/s, 2% TCP error rate
#   Every 60s:  payment-service latency spike (extra 500ms) for 15s
#   Every 120s: notification-service error burst (15%) for 15s
#
# TCP connections observed by aacyn per request:
#   traffic-gen → frontend:80
#   frontend → api:3000
#   api → db:5432
#   (+ connection-refused events on error simulation)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
TARGET="${TARGET_URL:-http://frontend}"
WORKERS=25
SPIKE_FILE="/tmp/.latency_spike"
BURST_FILE="/tmp/.error_burst"

# Cleanup on exit
trap 'kill 0 2>/dev/null; rm -f "$SPIKE_FILE" "$BURST_FILE"' EXIT INT TERM

# ─── Wait for API readiness (up to 30 seconds) ──────────────────────────────
echo "[aacyn] Waiting for the API to become ready..."
for ((i=0; i<30; i++)); do
    if curl -sf -o /dev/null --max-time 2 "${TARGET}/api/healthcheck" 2>/dev/null; then
        echo "[aacyn] API is ready."
        break
    fi
    if [ "$i" -eq 29 ]; then
        echo "[aacyn] WARNING: API did not respond within 30s. Starting traffic anyway."
    fi
    sleep 1
done

# ─── Banner ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  aacyn demo is live!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Dashboard:  http://localhost:3000/dashboard"
echo "  API:        http://localhost:3001/health"
echo "  Grafana:    http://localhost:3002 (if enabled)"
echo ""
echo "  The demo simulates a 5-service microservices cluster. Watch the"
echo "  topology graph for:"
echo "    - A latency spike every 60s (payment-service)"
echo "    - An error burst every 120s (notification-service)"
echo "    - Pre-configured alerts firing in the API logs"
echo ""
echo "  Press Ctrl+C to stop."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Worker function ────────────────────────────────────────────────────────
# Each worker simulates one of the 5 services, aiming for ~8 req/s.
# 25 workers × 8 req/s ≈ 200 req/s baseline.
worker() {
    local id="$1"
    local svc_idx=$((id % 5))
    local name

    case "$svc_idx" in
        0) name="api-gateway"      ;; 1) name="auth-service"     ;;
        2) name="payment-service"  ;; 3) name="inventory-service";;
        4) name="notification-service";;
    esac

    while :; do
        # ── Detect anomaly state ──────────────────────────────────────
        local err_rate=2
        local spike=""

        if [ -f "$SPIKE_FILE" ] && [ "$name" = "payment-service" ]; then
            spike="1"
        fi
        if [ -f "$BURST_FILE" ] && [ "$name" = "notification-service" ]; then
            err_rate=15
        fi

        # ── Build URL ─────────────────────────────────────────────────
        local url="${TARGET}/api/healthcheck"

        # Maybe generate a real TCP connection error (eBPF-observable)
        if [ $((RANDOM % 100)) -lt "$err_rate" ]; then
            # Connect to a closed port on frontend → immediate ECONNREFUSED
            # aacyn's sys_exit_connect tracepoint captures this as an error event
            curl -sf -o /dev/null --connect-timeout 2 --max-time 3 \
                "http://frontend:1/" 2>/dev/null || true
            # Still do a normal request so we don't lose the good traffic
            curl -sf -o /dev/null --max-time 5 "${url}" 2>/dev/null || true
        else
            curl -sf -o /dev/null --max-time 5 "${url}" 2>/dev/null || true
        fi

        # ── Latency spike simulation ──────────────────────────────────
        # During spike, payment-service takes an extra 500ms, simulating
        # a downstream dependency bottleneck in inventory-service.
        if [ -n "$spike" ]; then
            sleep 0.5
        fi

        # ── Rate limiting: ~8 req/s per worker ────────────────────────
        sleep 0.1
    done
}

# ─── Spawn workers ─────────────────────────────────────────────────────────
echo "[aacyn] Starting $WORKERS traffic workers (target: ~200 req/s)..."
for ((w=0; w<WORKERS; w++)); do
    worker "$w" &
done
echo "[aacyn] Traffic generation active."

# ─── Control loop: anomaly state management ─────────────────────────────────
# Manages the latency spike and error burst state files that workers check.
# Timing is based on wall-clock seconds since this script started.
FINISHED_AT=$(date +%s)
while :; do
    t=$(($(date +%s) - FINISHED_AT))

    # Latency spike: first 15s of every 60s cycle
    if [ $((t % 60)) -lt 15 ]; then
        touch "$SPIKE_FILE" 2>/dev/null
    else
        rm -f "$SPIKE_FILE" 2>/dev/null
    fi

    # Error burst: first 15s of every 120s cycle
    if [ $((t % 120)) -lt 15 ]; then
        touch "$BURST_FILE" 2>/dev/null
    else
        rm -f "$BURST_FILE" 2>/dev/null
    fi

    sleep 1
done
