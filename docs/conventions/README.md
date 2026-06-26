# Project Conventions

Tool-agnostic coding standards for aacyn. These apply regardless of which
editor, CLI, or AI assistant you use.

## File Index

| File | Scope |
|------|-------|
| `c.md` | C engine — memory safety, SIMD, FFI surface |
| `ebpf.md` | eBPF probes — verifier constraints, CO-RE, ring buffers |
| `typescript.md` | TypeScript — Elysia routes, FFI bridge, async patterns |
| `testing.md` | Test structure, coverage targets, mutation testing |
| `kubernetes.md` | Helm charts, Dockerfiles, eBPF in containers |
| `security.md` | Cryptography, auth, data handling |

## Usage with AI tools

These files are the source of truth. Configure your tool to include them:

```bash
# Symlink for Claude Code
ln -sf ../../docs/conventions .claude/rules

# Cursor: add to .cursorrules
#   Always follow the conventions in docs/conventions/

# GitHub Copilot: reference in .github/copilot-instructions.md
# Aider: reference in CONVENTIONS.md
```

The script `scripts/link-conventions.sh` sets up symlinks for supported tools.
