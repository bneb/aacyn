# aacyn — Cross-language build orchestration
# https://github.com/casey/just

set dotenv-load

# Constants
BUILD_DIR := "build"

# ─── Development ─────────────────────────────────────────────────────────────

# Start the Elysia API server in dev mode
dev-api:
    cd ts/apps/api && bun run dev

# Start the Next.js web UI in dev mode
dev-web:
    cd ts/apps/web && bun run dev

# Start both API and web in parallel
dev:
    just dev-api & just dev-web

# TDD: Watch Elysia API tests for instant feedback
tdd-api:
    cd ts/apps/api && bun test --watch

# ─── TypeScript ──────────────────────────────────────────────────────────────

ts-install:
    cd ts && bun install

ts-build:
    cd ts && bun run build

ts-lint:
    cd ts && bun run lint

ts-test:
    cd ts && bun run test

# ─── Native C Engine ─────────────────────────────────────────────────────────

# Ensure build directory exists
init-build:
    mkdir -p {{BUILD_DIR}}

# Build native C columnar store (libaacyn)
build-native: init-build
    @echo "Building libaacyn (native columnar store)..."
    cd native && make

# ─── Integration & E2E ───────────────────────────────────────────────────────

# The ultimate gatekeeper: builds native, then fires the smoke tests
test-e2e: build-native
    @echo "Firing End-to-End Smoke Tests..."
    cd ts/apps/api && bun test tests/smoke.test.ts

# k6 Siege Benchmark (JSON): 500 VUs × 100 events/req × 30s sustained
# Prerequisites: Elysia API must be running (just dev-api)
benchmark:
    @echo "🔥 Firing k6 JSON Siege Benchmark (500 VU)..."
    k6 run ts/apps/api/tests/benchmark.k6.js

# k6 Local Benchmark: 50 VUs × 10s — for laptop dev iteration
benchmark-local:
    @echo "🔥 Firing k6 Local Benchmark (50 VU)..."
    k6 run --vus 50 --duration 10s ts/apps/api/tests/benchmark.k6.js

# Pre-compile FlatBuffer binary payload for zero-parse siege
build-payload:
    @echo "📦 Generating FlatBuffer binary payload..."
    cd {{justfile_directory()}} && bun run benchmarks/generate_payload.ts

# k6 Siege Benchmark (Binary): 500 VUs × 100 events/req × 30s sustained
# Pre-compiles the payload, then blasts raw bytes from memory
benchmark-binary: build-payload
    @echo "🔥 Firing k6 Binary Siege Benchmark (500 VU)..."
    cd {{justfile_directory()}} && k6 run benchmarks/k6_binary.js

# Query Scan Benchmark: AVX-512 vectorized reads over 5M events
benchmark-scan: build-native
    @echo "🔬 Firing Query Scan Benchmark (5M events)..."
    cd {{justfile_directory()}} && bun run benchmarks/scan_benchmark.ts

# ─── CI ──────────────────────────────────────────────────────────────────────

# Validate Linux build via Docker (Ubuntu 24.04, AVX-512, libbpf)
test-linux-build:
    @echo "🐳 Building libaacyn in Ubuntu 24.04 Docker container..."
    docker build -f native/Dockerfile.ubuntu-test -t aacyn-build-test .
    @echo "✓ Linux build validation passed"

# Run full CI pipeline (TypeScript only)
ci-ts: ts-install ts-build ts-lint ts-test
    @echo "✓ TypeScript CI passed"

# ─── Utilities ───────────────────────────────────────────────────────────────

# Build the production appliance binary (bun compile + libaacyn.so)
# This is what customers receive — a single executable + native library.
build-appliance: build-native
    @echo "📦 Building production appliance binary..."
    mkdir -p {{BUILD_DIR}}/dist
    cd ts/apps/api && bun build --compile --minify src/index.ts --outfile ../../../{{BUILD_DIR}}/dist/aacyn-server
    cp {{BUILD_DIR}}/libaacyn.* {{BUILD_DIR}}/dist/
    cp LICENSE {{BUILD_DIR}}/dist/
    @echo "✓ Appliance package: {{BUILD_DIR}}/dist/"
    @echo "  Contents: aacyn-server + libaacyn.so + LICENSE"

clean:
    rm -rf {{BUILD_DIR}}
    cd ts && rm -rf node_modules
    find . -name ".next" -type d -exec rm -rf {} + 2>/dev/null || true
    find . -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true
    @echo "✓ Cleaned"
