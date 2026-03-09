---
name: sprint-start
description: Begin a sprint from SPRINT_ROADMAP.md. Loads the sprint's tasks, acceptance criteria, and sets the /goal for continuous progress.
arguments:
  - name: sprint
    description: Sprint number (1-12) or "current" for the next incomplete sprint
    required: true
---

# /sprint-start

Begin working on a specific sprint from `SPRINT_ROADMAP.md`.

## When the user invokes this skill

1. Read `SPRINT_ROADMAP.md` and locate the specified sprint section.
2. Extract from that sprint:
   - Sprint number and theme (e.g., "Sprint 1: Security Hardening (v0.8.1)")
   - All numbered tasks with their file paths
   - All acceptance criteria (the bullet list at the bottom of the sprint)
3. Report the sprint context to the user:
   ```
   ## Starting Sprint N: [Theme]
   
   Tasks:
   1.1 [task name] → [files]
   1.2 [task name] → [files]
   ...
   
   Acceptance Criteria:
   - [criterion 1]
   - [criterion 2]
   ...
   ```
4. Set the goal for continuous progress. Construct the goal condition from the acceptance criteria:
   ```
   /goal [all acceptance criteria, joined by commas]
   ```
   The goal should include measurable outcomes: "Stripe webhooks reject unsigned payloads with 400", not "webhook security improved".

5. If there are prerequisite sprints that are incomplete, warn the user but proceed — the user may be working in parallel or may have completed work without marking it.

6. If this is Sprint 1, also verify the `.claude/` quality infrastructure is in place:
   - Hooks executable
   - Settings.json valid
   - Agents available

## Sprint-specific context to load

For each sprint, also load the relevant path-scoped rules:
- Sprint 1, 2, 4: TypeScript rules
- Sprint 5: C engine rules, eBPF rules
- Sprint 3: TypeScript rules, testing rules
- Sprint 6, 7, 8: Kubernetes rules, TypeScript rules
- Sprint 10: TypeScript rules (forwarder code)
- Sprint 11: Security rules, TypeScript rules
- Sprint 12: Testing rules, security rules

Report these so the user knows which domain expertise is active.
