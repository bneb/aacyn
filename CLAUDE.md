# aacyn — Claude Code Project Instructions

## Project Identity

aacyn is an eBPF observability tool for Kubernetes. Zero-code TCP connection monitoring via kernel probes, a custom mmap'd columnar store (C, SIMD-accelerated), a TypeScript/Bun API control plane, a WebGPU dashboard, and a Grafana data source plugin.

**Current version:** v1.0.0-dev. **Target:** Best eBPF observability for developers. **Roadmap:** `SPRINT_ROADMAP.md`.

## Architecture

```
eBPF probes (kernel) → libaacyn.so (C, SoA columnar store) ←bun:ffi→ Elysia API (TS/Bun) → Next.js dashboard / Grafana plugin
```

Three languages, one data plane: C for the hot path (ingest, SIMD scans, eBPF consumer), TypeScript for the control plane (API, archiver), Go for the Grafana backend.

## Quality Gates (Non-Negotiable)

These apply to **every** change, enforced by hooks in `.claude/hooks/`:

| Gate | Threshold | Enforcement |
|------|-----------|-------------|
| Test coverage | ≥ 95% line coverage on changed files | Pre-commit hook + loop |
| Function length | ≤ 32 lines | PostToolUse hook (instant) |
| Nesting depth | ≤ 3 levels (indentation) | PostToolUse hook (instant) |
| Mutant elimination | 0 surviving mutants on changed code | `/run-mutation-tests` skill |
| Silent catch blocks | 0 empty `catch {}` blocks | PostToolUse hook |
| `as any` casts | 0 on the store interface | ESLint + review |
| TypeScript strict | `strict: true` in tsconfig | `tsc --noEmit` in pre-commit |
| ESLint zero errors/warnings | 0 ESLint errors, 0 warnings | Pre-commit hook |

## Common Commands

```bash
# TypeScript monorepo
cd ts && bun install          # Install deps
cd ts && bun test             # Run 58 TS tests
cd ts && bun run lint         # ESLint
cd ts && bun run typecheck    # tsc --noEmit

# Native C engine
cd native && make             # Build libaacyn.so
cd native && make test        # Run 14 C tests (test_ouroboros)
cd native && EBPF=1 make      # Build with eBPF support (Linux only)
cd native && make sanitize    # Build with ASan/UBSan

# Cross-language orchestration
just dev-api                   # Start API server (port 3001)
just dev-web                   # Start Next.js (port 3000)
just ts-test                   # Full TS test suite
just build-appliance           # Production binary
just benchmark                 # Run benchmarks

# Docker demo
cd docker-demo && docker compose up   # Full zero-instrumentation demo

# Grafana plugin
cd grafana-plugin && mage build       # Build plugin
```

## Current Sprint Context

See `SPRINT_ROADMAP.md` for the full 12-sprint plan. When starting a sprint, use `/sprint-start <N>` to load context and set the goal. Use `/sprint-check` to verify progress against acceptance criteria.

## Key Constraints

- **Never** commit secrets. `.env.production` contains real keys — it is gitignored. Use `.env.test` for test values.
- **C code changes** must compile on both macOS (NEON) and Linux (AVX-512). Test on both before committing.
- **eBPF changes** must pass the kernel verifier. Test on a real Linux kernel (Docker or VM) before committing.
- **FFI boundary changes** must keep the TypeScript `native-store.ts` definitions in sync with `libaacyn.c` exports.
- **Dashboard changes** go in `ts/packages/ui/src/` as React components, not inline in `routes/dashboard.ts`.

## File-Scoped Rules

Additional rules load automatically based on the files you touch:
- `native/**/*.c`, `*.h` → `.claude/rules/c-engine.md`
- `native/**/*.bpf.c` → `.claude/rules/ebpf.md`
- `ts/**/*.ts`, `*.tsx` → `.claude/rules/typescript.md`
- `**/*.test.*`, `**/*.spec.*` → `.claude/rules/testing.md`
- `charts/**`, `Dockerfile*` → `.claude/rules/kubernetes.md`
- `**/crypto.*`, `**/auth.*`, `**/webhooks.*` → `.claude/rules/security.md`
