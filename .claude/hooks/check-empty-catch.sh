#!/usr/bin/env bash
# PostToolUse hook: block empty catch blocks (silent error swallowing).
# Reads Edit/Write tool input from stdin JSON.
set -euo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check source files
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx) ;;
  *) exit 0 ;;
esac

# Find empty catch blocks: catch { or catch ( ... ) { followed by only whitespace until }
EMPTY_CATCHES=$(awk '
  /catch\s*\(/ || /catch\s*\{/ {
    in_catch = 1
    catch_line = NR
    brace_count = 0
    content_lines = 0
    next
  }
  in_catch && /\{/ { brace_count++ }
  in_catch && /\}/ {
    brace_count--
    if (brace_count == 0) {
      if (content_lines == 0) {
        printf "%s:%d: empty catch block (silently swallows errors)\n", FILENAME, catch_line
      }
      in_catch = 0
    }
  }
  in_catch && brace_count == 1 && !/^\s*$/ && !/^\s*\/\// && !/^\s*\{/ && !/^\s*\}/ {
    content_lines++
  }
' "$FILE" 2>/dev/null)

# Also detect: catch { /* fall through */ } or catch { }
# That's just a comment - still counts as empty
EMPTY_CATCHES_2=$(awk '
  /catch\s*\{/ {
    in = 1
    ln = NR
    body = ""
    next
  }
  in {
    body = body $0
    if (/\}/) {
      # Remove whitespace and comments, check if anything remains
      gsub(/\/\/.*/, "", body)
      gsub(/\/\*.*\*\//, "", body)
      gsub(/[[:space:]]/, "", body)
      if (body == "{}" || body == "") {
        printf "%s:%d: empty catch block\n", FILENAME, ln
      }
      in = 0
    }
  }
' "$FILE" 2>/dev/null)

ALL_EMPTY="${EMPTY_CATCHES}${EMPTY_CATCHES_2}"

if [[ -n "${ALL_EMPTY// /}" ]]; then
  cat <<BLOCK
{"decision":"block","reason":"Empty catch blocks found:\\n${ALL_EMPTY}"}
BLOCK
  exit 0
fi

exit 0
