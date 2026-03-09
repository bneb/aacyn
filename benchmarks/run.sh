#!/usr/bin/env bash
# ============================================================================
# aacyn Benchmark Runner
#
# Builds the native columnar engine, runs 3 benchmarks against both libaacyn
# and SQLite, and prints a comparison table.
#
# Usage:
#   ./benchmarks/run.sh                  # 10M events (default)
#   ./benchmarks/run.sh --quick          # 1M events  (CI)
#   ./benchmarks/run.sh 5000000          # 5M events
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"

EVENT_COUNT=10000000
QUICK_FLAG=0

for arg in "$@"; do
  case "$arg" in
    --quick) EVENT_COUNT=1000000; QUICK_FLAG=1 ;;
    --help|-h)
      echo "Usage: $0 [--quick|event_count]"
      exit 0 ;;
    *)
      if [[ "$arg" =~ ^[0-9]+$ ]]; then
        EVENT_COUNT="$arg"
      else
        echo "Unknown argument: $arg"
        echo "Usage: $0 [--quick|event_count]"
        exit 1
      fi
      ;;
  esac
done

# ── Colour helpers ──────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"
  RESET="\033[0m"; GREY="\033[90m"
else
  BOLD=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""; GREY=""
fi

header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}\n"; }
info()    { echo -e "  ${GREY}∘${RESET} $*"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $*"; }
warning() { echo -e "  ${YELLOW}⚠${RESET} $*"; }

# ── Number formatting helper ────────────────────────────────────────────────
format_num() {
  python3 -c "print('{:,}'.format($1))"
}

# ── 1. Hardware Info ────────────────────────────────────────────────────────
header "System"

OS="$(uname -s)"
ARCH="$(uname -m)"
CPU=""
MEM_GB=""

case "$OS" in
  Darwin)
    CPU="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model)"
    MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    MEM_GB="$(python3 -c "print(f'{float($MEM_BYTES)/1073741824:.0f}')" 2>/dev/null || echo "?")"
    CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo "?")"
    ;;
  Linux)
    CPU="$(grep 'model name' /proc/cpuinfo | head -1 | sed 's/.*: //' 2>/dev/null || echo "unknown")"
    MEM_GB="$(python3 -c "import os; print(round(os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / 1073741824))" 2>/dev/null || echo "?")"
    CORES="$(nproc 2>/dev/null || echo "?")"
    ;;
  *)
    CPU="unknown"; MEM_GB="?"; CORES="?"
    ;;
esac

echo "  OS:       $OS"
echo "  Arch:     $ARCH"
echo "  CPU:      $CPU"
echo "  Memory:   ${MEM_GB} GB"
echo "  Cores:    $CORES"
echo "  Events:   $(format_num $EVENT_COUNT)"
echo ""

# ── 2. Build Native Engine ─────────────────────────────────────────────────
header "Build"

info "Building libaacyn..."
(cd "$ROOT_DIR/native" && make) 2>&1 | grep -v "zoxide:" | grep -v "Disable" || true
# Check make's exit code via PIPESTATUS
if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
  echo "ERROR: Build failed" >&2
  exit 1
fi
ok "libaacyn built"

info "Compiling benchmark..."
cc -O3 -march=native -Wall -Wextra -std=c17 \
   -o "$BUILD_DIR/benchmark_ouroboros" \
   "$ROOT_DIR/native/benchmark_ouroboros.c" \
   "$ROOT_DIR/native/libaacyn.c" 2>&1 | grep -v "zoxide:" | grep -v "Disable" || true
if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
  echo "ERROR: Benchmark compilation failed" >&2
  exit 1
fi
ok "Benchmark binary ready"

# ── 3. Run libaacyn Benchmark ──────────────────────────────────────────────
header "libaacyn Benchmark"

C_STDERR=$(mktemp)
C_JSON=$("$BUILD_DIR/benchmark_ouroboros" "$EVENT_COUNT" 2>"$C_STDERR")
# Display stderr progress (filter zoxide noise)
grep -v "zoxide:" "$C_STDERR" | grep -v "Disable" | grep -v "detected" || true
rm -f "$C_STDERR"

echo "$C_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)['libaacyn']
print(f'  Ingest:   {d[\"ingest_events_per_sec\"]:>12,.0f} events/s')
print(f'  Scan:     {d[\"scan_events_per_sec\"]:>12,.0f} events/s')
print(f'  Query:    {d[\"error_query_latency_ms\"]:>10.3f} ms')
" 2>&1 || {
  warning "libaacyn benchmark failed to parse"
  C_JSON='{"libaacyn":{"ingest_events_per_sec":0,"scan_events_per_sec":0,"error_query_latency_ms":0,"events_inserted":0}}'
}

# ── 4. Run SQLite Benchmark ────────────────────────────────────────────────
header "SQLite Benchmark"

HAVE_SQLITE=0
SQL_JSON='{"sqlite":{"ingest_events_per_sec":0,"scan_events_per_sec":0,"error_query_latency_ms":0,"events_inserted":0}}'

if command -v sqlite3 &>/dev/null; then
  HAVE_SQLITE=1
  SQL_OUTPUT=$(python3 "$SCRIPT_DIR/benchmark_sqlite.py" "$EVENT_COUNT" 2>/dev/null) || {
    warning "SQLite benchmark failed"
    HAVE_SQLITE=0
  }
  if [[ "$HAVE_SQLITE" == "1" ]]; then
    SQL_JSON="$SQL_OUTPUT"
    echo "$SQL_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)['sqlite']; print(f'  Ingest:   {d[\"ingest_events_per_sec\"]:>12,.0f} events/s'); print(f'  Scan:     {d[\"scan_events_per_sec\"]:>12,.0f} events/s'); print(f'  Query:    {d[\"error_query_latency_ms\"]:>10.3f} ms')" 2>&1
  fi
else
  warning "sqlite3 not found — comparison column skipped"
  warning "Install: brew install sqlite3 (macOS) / apt install sqlite3 (Linux)"
fi

# ── 5. Results Table ───────────────────────────────────────────────────────
header "Results"

# Parse values
C_INGEST=$( echo "$C_JSON"  | python3 -c "import sys,json; print(json.load(sys.stdin)['libaacyn']['ingest_events_per_sec'])" 2>/dev/null || echo "0")
C_SCAN=$(  echo "$C_JSON"  | python3 -c "import sys,json; print(json.load(sys.stdin)['libaacyn']['scan_events_per_sec'])" 2>/dev/null || echo "0")
C_QUERY=$( echo "$C_JSON"  | python3 -c "import sys,json; print(json.load(sys.stdin)['libaacyn']['error_query_latency_ms'])" 2>/dev/null || echo "0")

if [[ "$HAVE_SQLITE" == "1" ]]; then
  S_INGEST=$( echo "$SQL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['sqlite']['ingest_events_per_sec'])" 2>/dev/null || echo "0")
  S_SCAN=$(  echo "$SQL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['sqlite']['scan_events_per_sec'])" 2>/dev/null || echo "0")
  S_QUERY=$( echo "$SQL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['sqlite']['error_query_latency_ms'])" 2>/dev/null || echo "0")

  printf "  %-20s | %-14s | %-12s\n" "Operation" "libaacyn" "SQLite"
  printf "  %-20s-+-%-14s-+-%-12s\n" "--------------------" "--------------" "------------"
  printf "  %-20s | %'14.0f | %'12.0f\n" "Ingest (events/s)" "$C_INGEST" "$S_INGEST"
  printf "  %-20s | %'14.0f | %'12.0f\n" "Scan (events/s)" "$C_SCAN" "$S_SCAN"
  printf "  %-20s | %'13.3f  | %'11.3f \n" "Error query (ms)" "$C_QUERY" "$S_QUERY"

  # Speedup column
  echo ""
  printf "  %-20s | %-14s\n" "Speedup" "libaacyn vs SQLite"
  printf "  %-20s-+-%-14s\n" "--------------------" "--------------"
  INGEST_SPEEDUP=$(python3 -c "print(f'{float($C_INGEST)/float($S_INGEST):.1f}x' if float($S_INGEST)>0 else 'N/A')" 2>/dev/null)
  SCAN_SPEEDUP=$(python3 -c "print(f'{float($C_SCAN)/float($S_SCAN):.1f}x' if float($S_SCAN)>0 else 'N/A')" 2>/dev/null)
  QUERY_SPEEDUP=$(python3 -c "print(f'{float($S_QUERY)/float($C_QUERY):.1f}x' if float($C_QUERY)>0 else 'N/A')" 2>/dev/null)
  printf "  %-20s | %-14s\n" "Ingest" "$INGEST_SPEEDUP"
  printf "  %-20s | %-14s\n" "Scan" "$SCAN_SPEEDUP"
  printf "  %-20s | %-14s\n" "Error query" "$QUERY_SPEEDUP"
else
  printf "  %-20s | %-14s\n" "Operation" "libaacyn"
  printf "  %-20s-+-%-14s\n" "--------------------" "--------------"
  printf "  %-20s | %'14.0f\n" "Ingest (events/s)" "$C_INGEST"
  printf "  %-20s | %'14.0f\n" "Scan (events/s)" "$C_SCAN"
  printf "  %-20s | %'13.3f \n" "Error query (ms)" "$C_QUERY"
  echo ""
  echo "  Install sqlite3 for comparison benchmarks:"
  echo "    macOS: brew install sqlite"
  echo "    Linux: apt install sqlite3"
fi

# ── 6. Write results.json ──────────────────────────────────────────────────
python3 -c "
import json

hardware = {
    'os': '$OS',
    'arch': '$ARCH',
    'cpu': '$CPU',
    'memory_gb': $MEM_GB,
    'cores': $CORES,
}

# Parse the two JSON outputs
c = json.loads('''$C_JSON'''.strip())['libaacyn']
s = json.loads('''$SQL_JSON'''.strip())['sqlite']

result = {
    'timestamp': __import__('datetime').datetime.now().isoformat(),
    'hardware': hardware,
    'event_count': $EVENT_COUNT,
    'quick': bool($QUICK_FLAG),
    'libaacyn': c,
}
if $HAVE_SQLITE:
    result['sqlite'] = s

with open('$SCRIPT_DIR/results.json', 'w') as f:
    json.dump(result, f, indent=2)

print()
print(f'  Results written to benchmarks/results.json')
"

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "  ${GREEN}Benchmark complete.${RESET}"
echo ""

exit 0
