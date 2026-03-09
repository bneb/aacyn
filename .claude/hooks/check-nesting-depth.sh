#!/usr/bin/env bash
# PostToolUse hook: enforce ≤ 3 levels of indentation nesting.
# Reads Edit/Write tool input from stdin JSON.
set -euo pipefail

MAX_DEPTH=3
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check source files
case "$FILE" in
  *.ts|*.tsx|*.c|*.h|*.go) ;;
  *) exit 0 ;;
esac

# Determine indent width from file content
INDENT=2
if grep -q '^    ' "$FILE" 2>/dev/null; then
  INDENT=4
fi

# Count leading spaces to determine nesting depth.
# depth = floor(leading_spaces / indent_width)
# We flag lines where depth > MAX_DEPTH.
# Exclude: blank lines, comments that are intentionally left-aligned,
# multi-line strings (hard to detect statically, but rare at deep nesting).

OVER_NESTED=$(awk -v indent="$INDENT" -v max="$MAX_DEPTH" '
{
  line = $0
  # Skip blank lines and pure comment lines
  if (line ~ /^\s*$/) next
  if (line ~ /^\s*\/\//) next
  if (line ~ /^\s*\/\*/) next
  if (line ~ /^\s*\*\s/) next  # block comment continuation
  if (line ~ /^\s*#/) next     # preprocessor directives (C)

  # Count leading spaces
  match(line, /^[ ]*/)
  spaces = RLENGTH
  if (spaces == 0) next

  depth = int(spaces / indent)
  if (depth > max) {
    if (!seen[FILENAME]) {
      printf "  %s:\n", FILENAME
      seen[FILENAME] = 1
    }
    printf "    line %d (depth %d): %s\n", NR, depth, substr(line, 1, 80)
    count++
  }
}
END {
  if (count > 0) printf "  Total: %d lines exceed max nesting depth %d\n", count, max
}' "$FILE" 2>/dev/null)

if [[ -n "$OVER_NESTED" ]]; then
  cat <<BLOCK
{"decision":"block","reason":"Nesting depth exceeds ${MAX_DEPTH} levels:\\n${OVER_NESTED}"}
BLOCK
  exit 0
fi

exit 0
