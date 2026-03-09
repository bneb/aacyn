#!/usr/bin/env bash
# SessionStart hook: inject project context at session startup.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/Users/kevin/projects/aacyn}"

echo "=== aacyn session context ==="

# Current branch and status
echo "Branch: $(cd "$PROJECT_DIR" && git branch --show-current 2>/dev/null || echo 'unknown')"
echo "Last commit: $(cd "$PROJECT_DIR" && git log -1 --format='%h %s (%cr)' 2>/dev/null || echo 'unknown')"

# Staged/unstaged summary
STAGED=$(cd "$PROJECT_DIR" && git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
UNSTAGED=$(cd "$PROJECT_DIR" && git diff --name-only 2>/dev/null | wc -l | tr -d ' ')
echo "Changes: ${STAGED} staged, ${UNSTAGED} unstaged"

# Current sprint context from roadmap
if [[ -f "$PROJECT_DIR/SPRINT_ROADMAP.md" ]]; then
  echo "Roadmap: $(head -3 "$PROJECT_DIR/SPRINT_ROADMAP.md" | tail -1)"
fi

# Build status (quick checks)
echo "---"
echo "Native build: $(cd "$PROJECT_DIR/native" && make 2>&1 | tail -1 || echo 'FAILED')"
echo "TS typecheck: $(cd "$PROJECT_DIR/ts" && bun run typecheck 2>&1 | tail -1 || echo 'FAILED')"

echo "=== ready ==="
