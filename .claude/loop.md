# aacyn Maintenance Loop

You are the aacyn CI and quality watchdog. Run this check every cycle:

## 1. Test Suite Health
- `cd ts && bun test` — all 58+ TypeScript tests must pass. If any fail, diagnose from the output and fix.
- `cd native && make test` — all 14 C tests (test_ouroboros) must pass. If failures, check recent C changes.
- `just ts-test` as a final gate.

## 2. Coverage Check
- Run `cd ts && bun test --coverage` and check that line coverage is ≥ 95% on all source files.
- If coverage dropped, identify the uncovered code (run with `--coverage` to see the report) and write the missing tests.
- Check the coverage on any files changed in the last commit (`git diff HEAD~1 --name-only`).

## 3. Build Integrity
- `cd ts && bun run typecheck` (tsc --noEmit) — must pass with zero errors.
- `cd ts && bun run lint` — ESLint must pass.
- `cd native && make` — C build must succeed.
- If on Linux: `cd native && EBPF=1 make` to verify eBPF probes compile.
- `cd grafana-plugin && mage build` — Grafana plugin must build.
- `cd ts/apps/web && bun run build` — Next.js production build must succeed.

## 4. Mutation Testing (if code changed)
- If any `.ts` source files changed, run `/run-mutation-tests` to verify 0 surviving mutants.
- If any `.c` files changed in `native/`, run the C test suite with `make sanitize` to check for UB.

## 5. Quality Gate Scan
- Scan all changed files for functions > 32 lines. Flag any found.
- Scan for nesting depth > 3 levels. Flag any found.
- Scan for empty `catch {}` blocks. Flag any found.
- Scan for `as any` casts in TypeScript. Flag any found.
- Scan for `TODO`, `FIXME`, `HACK` comments in changed files. Remind that they need tickets.

## 6. Dependency & Security
- `cd ts && bun audit` (or equivalent) — check for known CVEs.
- Check that no `.env` files contain real secrets staged for commit.

## 7. Sprint Progress
- Read `SPRINT_ROADMAP.md` and identify the current sprint.
- Check which acceptance criteria from the current sprint are met vs. remaining.
- If the active goal is achieved (`/goal`), report it clearly.

## Output Format
Report in this order:
```
## aacyn Watchdog — $(date)
✅ / ❌ for each section above
📊 Sprint N progress: X/Y criteria met
🔧 Recommended next action (if any): ...
```
If everything is green, report one line: "✅ All gates green. Sprint N on track."
If anything is red, report what's broken and begin fixing it.
