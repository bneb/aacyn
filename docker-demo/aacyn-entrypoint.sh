#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# aacyn-entrypoint.sh — eBPF sidecar startup wrapper
#
# 1. Mounts debugfs if not already mounted (required for tracepoints)
# 2. Verifies kernel eBPF support
# 3. Starts the aacyn engine via Bun
# ─────────────────────────────────────────────────────────────────────────────

set -e

echo "┌──────────────────────────────────────────────────┐"
echo "│  aacyn Docker Sidecar — eBPF Mode                │"
echo "└──────────────────────────────────────────────────┘"

# Mount debugfs if not already present (required for tracepoints)
if ! mountpoint -q /sys/kernel/debug 2>/dev/null; then
    echo "[eBPF] Mounting debugfs..."
    mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null || \
        echo "[eBPF] Warning: Could not mount debugfs (read-only volume?)"
fi

# Verify kernel eBPF support
echo "[eBPF] Kernel: $(uname -r)"
echo "[eBPF] Arch:   $(uname -m)"
if [ -d "/sys/kernel/debug/tracing/events/syscalls" ]; then
    echo "[eBPF] ✅ Tracepoint syscalls available"
    if [ -f "/sys/kernel/debug/tracing/events/syscalls/sys_enter_accept4/id" ]; then
        echo "[eBPF] ✅ accept4 tracepoint confirmed"
    else
        echo "[eBPF] ⚠️  accept4 tracepoint not found — falling back to kprobe"
    fi
else
    echo "[eBPF] ⚠️  Syscall tracepoints not found — check debugfs mount"
fi

# Verify native library
if [ -f "$LIBAACYN_PATH" ]; then
    echo "[eBPF] ✅ Native library: $LIBAACYN_PATH"
    file "$LIBAACYN_PATH" | sed 's/^/     /'
else
    echo "[eBPF] ⚠️  Native library not found at $LIBAACYN_PATH"
fi

# Verify BPF object
if [ -f "$AACYN_BPF_OBJ" ]; then
    echo "[eBPF] ✅ BPF object: $AACYN_BPF_OBJ"
else
    echo "[eBPF] ⚠️  BPF object not found at $AACYN_BPF_OBJ"
fi

echo ""
echo "[eBPF] Starting aacyn engine..."
echo ""

# Exec into the aacyn server via Bun (replaces this shell process)
exec bun run /opt/aacyn/server/src/index.ts "$@"
