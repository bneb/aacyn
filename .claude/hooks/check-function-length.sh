#!/usr/bin/env bash
# PostToolUse hook: enforce ≤ 32 lines per function body.
# Reads the Edit/Write tool input from stdin JSON.
set -euo pipefail

MAX_LINES=32
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check source files
case "$FILE" in
  *.ts|*.tsx|*.c|*.h|*.go) ;;
  *) exit 0 ;;
esac

# Detect functions exceeding MAX_LINES between opening brace and closing brace.
# Strategy: track brace-open line numbers, subtract when brace closes.
# We count from the line containing `{` that opens a function body to the
# matching `}` line. Only counts top-level or method functions.

LONG_FUNCTIONS=""

if [[ "$FILE" == *.ts || "$FILE" == *.tsx ]]; then
  # Match TypeScript function/method/arrow declarations followed by {
  # Patterns: "function name(", "const name = (", "name(", "=> {"
  LONG_FUNCTIONS=$(awk -v max="$MAX_LINES" '
    /^\s*(export\s+)?(async\s+)?function\s/        { fn_name=$0; fn_line=NR; brace=0; in_fn=1; next }
    /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/ { fn_name=$0; fn_line=NR; brace=0; in_fn=1; next }
    /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\w+\s*=>/ { fn_name=$0; fn_line=NR; brace=0; in_fn=1; next }
    /^\s*(public|private|protected|async|static)+\s+\w+\s*\(/ { fn_name=$0; fn_line=NR; brace=0; in_fn=1; next }
    /^\s*\w+\s*\([^)]*\)\s*\{/ { fn_name=$0; fn_line=NR; brace=0; in_fn=1; next }
    in_fn && /\{/ { brace++ }
    in_fn && /\}/ {
      brace--
      if (brace == 0) {
        len = NR - fn_line
        if (len > max) printf "%s:%d-%d (%d lines, max %d)\n", FILENAME, fn_line, NR, len, max
        in_fn = 0
      }
    }
  ' "$FILE" 2>/dev/null)
elif [[ "$FILE" == *.c || "$FILE" == *.h ]]; then
  LONG_FUNCTIONS=$(awk -v max="$MAX_LINES" '
    /^\s*(static\s+)?(inline\s+)?(const\s+)?\w+\s+\w+\s*\([^)]*\)\s*\{/ {
      fn_name=$0; fn_line=NR; brace=1
      if (brace == 1) next  # opening brace on same line
    }
    brace > 0 && /\{/ { brace++ }
    brace > 0 && /\}/ {
      brace--
      if (brace == 0) {
        len = NR - fn_line
        if (len > max) printf "%s:%d-%d (%d lines, max %d)\n", FILENAME, fn_line, NR, len, max
      }
    }
  ' "$FILE" 2>/dev/null)
elif [[ "$FILE" == *.go ]]; then
  LONG_FUNCTIONS=$(awk -v max="$MAX_LINES" '
    /^func\s/ { fn_name=$0; fn_line=NR; brace=0; in_fn=1 }
    in_fn && /\{/ { brace++ }
    in_fn && /\}/ {
      brace--
      if (brace == 0) {
        len = NR - fn_line
        if (len > max) printf "%s:%d-%d (%d lines, max %d)\n", FILENAME, fn_line, NR, len, max
        in_fn = 0
      }
    }
  ' "$FILE" 2>/dev/null)
fi

if [[ -n "$LONG_FUNCTIONS" ]]; then
  cat <<BLOCK
{"decision":"block","reason":"Functions exceed max length (${MAX_LINES} lines):\\n${LONG_FUNCTIONS}"}
BLOCK
  exit 0
fi

exit 0
