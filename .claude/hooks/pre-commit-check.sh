#!/usr/bin/env bash
# PreToolUse hook: gate git commits on test + typecheck + lint passing.
# Runs before `git commit` is executed.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/Users/kevin/projects/aacyn}"
FAILURES=()

echo "=== pre-commit gate ==="

# 1. TypeScript typecheck
echo "→ TypeScript typecheck..."
if (cd "$PROJECT_DIR/ts" && bun run typecheck 2>&1); then
  echo "  ✅ typecheck passed"
else
  FAILURES+=("typecheck failed")
fi

# 2. ESLint (root config on all files)
echo "→ ESLint..."
if (cd "$PROJECT_DIR/ts" && bun run lint 2>&1); then
  echo "  ✅ lint passed"
else
  FAILURES+=("lint failed")
fi

# 3. Check staged file length (max 500 LOC)
echo "→ File length check..."
STAGED_SRC=$(cd "$PROJECT_DIR" && git diff --cached --name-only --diff-filter=ACM | grep -E "\.(ts|tsx|c|h|go)$" || true)
LONG_FILES=()
if [[ -n "$STAGED_SRC" ]]; then
  while IFS= read -r f; do
    lines=$(wc -l < "$PROJECT_DIR/$f")
    if [ "$lines" -gt 500 ]; then
      echo "  ⚠️  $f is $lines lines (max 500)"
      LONG_FILES+=("$f ($lines lines)")
    fi
  done <<< "$STAGED_SRC"
  if [[ ${#LONG_FILES[@]} -gt 0 ]]; then
    printf -v LONG_LIST '%s, ' "${LONG_FILES[@]}"
    FAILURES+=("file length exceeded: ${LONG_LIST%, }")
  else
    echo "  ✅ all files ≤ 500 lines"
  fi
else
  echo "  ✅ no source files staged"
fi

# 4. Run tests for changed modules
echo "→ Running affected tests..."
if (cd "$PROJECT_DIR/ts" && bun test 2>&1); then
  echo "  ✅ tests passed"
else
  FAILURES+=("tests failed")
fi

# 5. Check coverage on changed files (if coverage data available)
echo "→ Coverage check..."
if (cd "$PROJECT_DIR/ts" && bun test --coverage 2>&1 | tail -20); then
  # Parse coverage output to check ≥ 95%
  echo "  (verify coverage ≥ 95% manually in output above)"
else
  echo "  ⚠️  coverage run had issues (non-blocking if tests pass)"
fi

# 6. C tests if native files changed
STAGED_C=$(cd "$PROJECT_DIR" && git diff --cached --name-only --diff-filter=ACM | grep -E '\.(c|h)$' | grep '^native/' || true)
if [[ -n "$STAGED_C" ]]; then
  echo "→ C tests (native files staged)..."
  if (cd "$PROJECT_DIR/native" && make test 2>&1); then
    echo "  ✅ C tests passed"
  else
    FAILURES+=("C tests failed")
  fi
fi

# 7. Check for secrets in staged files
echo "→ Secrets scan..."
if (cd "$PROJECT_DIR" && git diff --cached | grep -iE '(sk_live_|whsec_|-----BEGIN PRIVATE KEY-----|re_[a-zA-Z0-9]{20,})' 2>/dev/null); then
  FAILURES+=("possible secrets in staged changes")
else
  echo "  ✅ no secrets detected"
fi

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  printf -v FAIL_LIST '%s, ' "${FAILURES[@]}"
  cat <<BLOCK
{"decision":"block","reason":"Pre-commit checks failed: ${FAIL_LIST%, }"}
BLOCK
  exit 0
fi

echo "=== all pre-commit gates passed ==="
exit 0
