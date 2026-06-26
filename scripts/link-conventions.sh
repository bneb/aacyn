#!/usr/bin/env bash
# Symlink tool-specific paths to docs/conventions/
# Usage: bash scripts/link-conventions.sh [tool]
#   all       — link all supported tools (default)
#   claude    — Claude Code: .claude/rules -> docs/conventions
#   cursor    — Cursor: prints .cursorrules snippet
#   copilot   — GitHub Copilot: prints .github/copilot-instructions.md snippet

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONVENTIONS="$ROOT/docs/conventions"

link_claude() {
  echo "  .claude/rules -> docs/conventions"
  rm -rf "$ROOT/.claude/rules"
  ln -sf ../docs/conventions "$ROOT/.claude/rules"
}

show_cursor() {
  echo "  Add to .cursorrules:"
  echo "  Always follow the coding conventions in docs/conventions/"
  echo "  See: docs/conventions/README.md for the full index."
}

show_copilot() {
  echo "  Add to .github/copilot-instructions.md:"
  echo "  Follow docs/conventions/ for language-specific standards."
}

case "${1:-all}" in
  all)
    echo "Linking conventions for all supported tools..."
    link_claude
    show_cursor
    show_copilot
    ;;
  claude)   link_claude ;;
  cursor)   show_cursor ;;
  copilot)  show_copilot ;;
  *)
    echo "Unknown tool: $1"
    echo "Usage: bash scripts/link-conventions.sh [all|claude|cursor|copilot]"
    exit 1
    ;;
esac
echo "Done."
