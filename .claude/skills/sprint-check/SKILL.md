---
name: sprint-check
description: Verify progress against the current sprint's acceptance criteria. Check which tasks are done, which remain, and what the quality gates say.
---

# /sprint-check

Verify progress against the current sprint from `SPRINT_ROADMAP.md`.

## When the user invokes this skill

1. Check the active goal (`/goal` status). If no goal is active, ask which sprint to check.

2. Read `SPRINT_ROADMAP.md` and locate the current sprint.

3. For each task in the sprint, determine status by checking:
   - **File existence**: Do the target files exist with the expected changes?
   - **Test passing**: Run the relevant test suite for those files.
   - **Quality gates**: Check function length, nesting depth, empty catches for changed files.
   - **Coverage**: Run `cd ts && bun test --coverage` and check ≥ 95% on changed files.

4. For each acceptance criterion, determine if it's met by checking evidence:
   - "Stripe webhooks reject unsigned payloads" → check that `constructEvent()` is called, run `grep -r "constructEvent" ts/`
   - "API returns 401 for unauthenticated requests" → `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/v1/query`
   - "All tests pass" → run the test suite

5. Produce a status report:
   ```
   ## Sprint N Progress: X/Y criteria met
   
   ### Tasks
   ✅ 1.1 [task name]
   ✅ 1.2 [task name]
   🔴 1.3 [task name] — [what's missing]
   ⬜ 1.4 [task name] — not started
   
   ### Acceptance Criteria
   ✅ [criterion]
   🔴 [criterion] — [what's still failing]
   
   ### Quality Gates
   Function length: [PASS/FAIL] — [N violations]
   Nesting depth: [PASS/FAIL] — [N violations]
   Empty catches: [PASS/FAIL] — [N found]
   `as any` casts: [PASS/FAIL] — [N found]
   Test coverage: [X%] — [PASS/FAIL]
   
   ### Next Action
   [What to work on next to unblock the remaining criteria]
   ```

6. If all criteria are met, suggest running `/sprint-start <N+1>` to begin the next sprint.
