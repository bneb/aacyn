#!/usr/bin/env bash
# PreToolUse hook: block known destructive commands.
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Patterns that are always dangerous
if echo "$COMMAND" | grep -qE 'rm -rf /[^a-z]'; then
  echo '{"decision":"block","reason":"Destructive rm -rf on root path blocked. If intentional, narrow the path."}'
  exit 0
fi

if echo "$COMMAND" | grep -qE 'rm -rf ~'; then
  echo '{"decision":"block","reason":"Destructive rm -rf on home directory blocked. If intentional, narrow the path."}'
  exit 0
fi

if echo "$COMMAND" | grep -qE '>\s*/dev/sd'; then
  echo '{"decision":"block","reason":"Writing to raw block device blocked."}'
  exit 0
fi

if echo "$COMMAND" | grep -qE 'dd\s+if=.*of=/dev/sd'; then
  echo '{"decision":"block","reason":"dd to raw block device blocked."}'
  exit 0
fi

if echo "$COMMAND" | grep -qE 'git push --force.*(main|master)'; then
  echo '{"decision":"block","reason":"Force push to main/master blocked. Use a branch."}'
  exit 0
fi

exit 0
