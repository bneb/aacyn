#!/usr/bin/env bash
# SubagentStart hook: inject quality constraints into every subagent.
# The hook output is prepended to the subagent's system prompt.
set -euo pipefail

cat <<'CONSTRAINTS'
## Quality Constraints (Non-Negotiable)

You must follow these constraints on every code change:

1. **Test coverage ≥ 95%** — Every new function, branch, and edge case must have a corresponding test. If coverage drops below 95%, add tests until it recovers.

2. **Functions ≤ 32 lines** — Break up functions longer than 32 lines. Extract helpers with descriptive names. A function should do one thing.

3. **Nesting depth ≤ 3 levels** — Use early returns, guard clauses, and extracted functions to flatten deep nesting. Never exceed 3 indentation levels.

4. **Zero mutant survival** — Every test must catch injected faults. If you introduce a deliberate bug (inverted condition, off-by-one, null instead of value), at least one test must fail.

5. **Zero silent error swallowing** — Never write `catch {}` or `catch { /* fall through */ }`. Every error must be at minimum logged, preferably handled or propagated.

6. **Zero `as any` casts on the store interface** — Use the typed `IStore` interface. If a method is missing, add it to the interface.

7. **TypeScript strict mode** — No `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why it's unavoidable.

8. **C safety** — Every pointer dereference must have a NULL check. Every allocation must have a corresponding free path. No `memcpy` without bounds verification.

9. **eBPF safety** — All eBPF probe code must pass the kernel verifier. All memory accesses must use `bpf_probe_read` for user-space pointers. Loop bounds must be compile-time constants.

10. **File length ≤ 500 lines** — Split files longer than 500 lines into modules. Extract related functions into separate files.

11. **Commit hygiene** — Atomic commits with descriptive messages. No "WIP" or "fix" commits on main. Reference sprint and task numbers.
CONSTRAINTS
