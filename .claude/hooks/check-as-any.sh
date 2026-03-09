#!/usr/bin/env bash
# PostToolUse hook: flag `as any` casts on the store interface.
# These bypass TypeScript type safety on the critical FFI boundary.
# Reads Edit/Write tool input from stdin JSON.
set -euo pipefail

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check TypeScript route and lib files where the store is used
case "$FILE" in
  */routes/*.ts|*/lib/native-store.ts|*/lib/store.ts) ;;
  *) exit 0 ;;
esac

# Find `as any` casts
AS_ANY=$(grep -n 'as any' "$FILE" 2>/dev/null || true)

if [[ -n "$AS_ANY" ]]; then
  cat <<BLOCK
{"decision":"block","reason":"\`as any\` casts found in store-interface code. Use the typed IStore interface instead.\\n$(echo "$AS_ANY" | head -20)"}
BLOCK
  exit 0
fi

exit 0
