#!/bin/bash
# build-release.sh — Assemble a release tarball for distribution
#
# Usage:
#   ./scripts/build-release.sh [version]
#
# Output:
#   build/aacyn-linux-x86_64.tar.gz  (or darwin-arm64, etc.)
#
# The tarball contains:
#   aacyn/
#     lib/libaacyn.so (or .dylib)
#     lib/aacyn_probes.bpf.o (Linux only)
#     server/            (TypeScript API server)
#     bin/bun            (Bun runtime)
#     aacyn.toml         (example config)
#     README.md

set -euo pipefail

VERSION="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${ROOT}/build"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

RELEASE_NAME="aacyn-${OS}-${ARCH}"
STAGING="${BUILD}/release/${RELEASE_NAME}"
TARBALL="${BUILD}/${RELEASE_NAME}.tar.gz"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Building release: ${RELEASE_NAME}"
echo "║  Version: ${VERSION}"
echo "╚══════════════════════════════════════════════════════╝"

# ── Clean ─────────────────────────────────────────────────────────────────────

rm -rf "${STAGING}" "${TARBALL}"
mkdir -p "${STAGING}/lib" "${STAGING}/server" "${STAGING}/bin"

# ── Step 1: Build native library ─────────────────────────────────────────────

echo "▸ Building native library..."
make -C "${ROOT}/native" TARGET_ONLY=1

if [ "$OS" = "linux" ]; then
  cp "${BUILD}/libaacyn.so" "${STAGING}/lib/"

  # Build eBPF probes only if libbpf-dev is installed AND vmlinux.h exists
  if dpkg -s libbpf-dev &>/dev/null && [ -f "${ROOT}/native/vmlinux.h" ]; then
    echo "▸ Building eBPF probes..."
    make -C "${ROOT}/native" EBPF=1
    [ -f "${BUILD}/aacyn_probes.bpf.o" ] && cp "${BUILD}/aacyn_probes.bpf.o" "${STAGING}/lib/"
    [ -f "${BUILD}/aacyn_auto.bpf.o" ] && cp "${BUILD}/aacyn_auto.bpf.o" "${STAGING}/lib/"
  else
    echo "▸ Skipping eBPF (requires libbpf-dev + vmlinux.h)"
  fi
elif [ "$OS" = "darwin" ]; then
  cp "${BUILD}/libaacyn.dylib" "${STAGING}/lib/"
fi
echo "✓ Native library"

# ── Step 2: Bundle TypeScript API server ──────────────────────────────────────

echo "▸ Bundling API server..."
cd "${ROOT}/ts/apps/api"

# Install deps if needed
[ -d "node_modules" ] || bun install --frozen-lockfile 2>/dev/null || bun install

# Copy server source (Bun runs from source, no transpile needed)
cp -r src "${STAGING}/server/"
cp package.json "${STAGING}/server/"
cp -r node_modules "${STAGING}/server/" 2>/dev/null || true

cd "$ROOT"
echo "✓ API server bundled"

# ── Step 3: Include Bun runtime ───────────────────────────────────────────────

echo "▸ Including Bun runtime..."
BUN_PATH=$(command -v bun)
cp "$BUN_PATH" "${STAGING}/bin/bun"
chmod +x "${STAGING}/bin/bun"
echo "✓ Bun runtime ($(bun --version))"

# ── Step 4: Config & Docs ────────────────────────────────────────────────────

cp "${ROOT}/aacyn.toml" "${STAGING}/" 2>/dev/null || true

cat > "${STAGING}/README.md" << EOF
# aacyn ${VERSION}

5M events/sec bare-metal observability engine.

## Quick Start

    aacyn                                    # Start the server
    curl -X POST localhost:3001/ingest       # Send events
    curl localhost:3001/query                # Query the store

## OTLP (OpenTelemetry)

    export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3001

Any OTel SDK (Go, Node, Python, Java, Rust) works out of the box.

## Configuration

Edit aacyn.toml to configure filter rules:

    [[filters]]
    column = "duration"
    op = "lt"
    threshold = 1.0
    action = "drop"

## Documentation

https://aacyn.com/docs
EOF

# ── Step 5: Create tarball ────────────────────────────────────────────────────

echo "▸ Creating tarball..."
cd "${BUILD}/release"
tar -czf "${TARBALL}" "${RELEASE_NAME}"
cd "$ROOT"

SIZE=$(du -h "${TARBALL}" | cut -f1)
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✓ Release tarball ready                            ║"
echo "║  ${TARBALL}"
echo "║  Size: ${SIZE}"
echo "╚══════════════════════════════════════════════════════╝"
