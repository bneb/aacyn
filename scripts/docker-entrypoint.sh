#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# docker-entrypoint.sh — aacyn Container Entrypoint
#
# Reads AACYN_MODE env var and starts the aacyn API server accordingly.
#
# Modes:
#   node         — eBPF node agent (requires privileged + host PID)
#   aggregator   — central aggregation endpoint (no eBPF needed)
#   standalone   — combined node + local aggregator (default)
# ─────────────────────────────────────────────────────────────────────────────

set -e

MODE="${AACYN_MODE:-standalone}"

echo "┌──────────────────────────────────────────────────┐"
echo "│  aacyn v0.9.0                                    │"
printf "│  Mode: %-41s│\n" "${MODE}"
echo "└──────────────────────────────────────────────────┘"

# ─── Mode-specific setup ─────────────────────────────────────────────────────

case "${MODE}" in
  node|standalone)
    # Node / standalone modes need the native eBPF library

    if [ -f "${LIBAACYN_PATH}" ]; then
      echo "[aacyn]  Native library: ${LIBAACYN_PATH}"
    else
      echo "[aacyn]  WARNING: Native library not found at ${LIBAACYN_PATH}"
      echo "[aacyn]  eBPF probes will be unavailable"
    fi

    if [ -f "${AACYN_BPF_OBJ}" ]; then
      echo "[aacyn]  BPF object:     ${AACYN_BPF_OBJ}"
    else
      echo "[aacyn]  WARNING: BPF object not found at ${AACYN_BPF_OBJ}"
    fi

    # Mount debugfs if available (required for eBPF tracepoints)
    if [ -d "/sys/kernel/debug" ] && ! mountpoint -q /sys/kernel/debug 2>/dev/null; then
      mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null && \
        echo "[aacyn]  debugfs mounted" || \
        echo "[aacyn]  Could not mount debugfs (non-privileged container?)"
    fi
    ;;
  aggregator)
    # Aggregator mode — pure HTTP, no eBPF needed
    echo "[aacyn]  Aggregator mode — no eBPF initialization required"
    ;;
  *)
    echo "[aacyn]  ERROR: Unknown AACYN_MODE '${MODE}'"
    echo "[aacyn]  Valid modes: node, aggregator, standalone"
    exit 1
    ;;
esac

echo ""
echo "[aacyn]  Starting API server..."
echo ""

# Exec replaces the shell process so signals reach Bun directly
exec bun run /opt/aacyn/ts/apps/api/src/index.ts "$@"
