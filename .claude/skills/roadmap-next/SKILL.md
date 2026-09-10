---
name: roadmap-next
description: Reconcile ROADMAP.md with what actually shipped and propose the next 1–3 items, separating code work Claude can start from items blocked on the operator. Use when asked "what next", "update the roadmap", or at the start of a build session.
---

# /roadmap-next

ROADMAP.md is the plan of record; its status markers (**DECIDED**, **IN PROGRESS**,
**BUILT <date>**, **DEPLOYED <date>**, **BLOCKED (operator)**) and checkboxes drift from
reality. This skill keeps them honest and picks the next item with evidence.

## Procedure

1. **What shipped**: `git log --since="<date of the newest 'Shipped' block>" --format='%h %ad %s' --date=short`. Group commits by roadmap item (A1…F) from their subjects.
2. **Status markers**: `grep -n "^## \|^### \|^- \[ \] \*\*" ROADMAP.md`. Tick a checkbox or add **BUILT** only when the code is on `main` (`git branch --contains <hash>` includes `main`). **DEPLOYED** only when confirmed on a live host — there is no CI deploy yet, so never mark it from memory.
3. **Blocked-on-human**: read `docs/OPERATOR_TODO.md`. Any roadmap item whose next step is there is "blocked (operator)" — say so and do not propose it as code work. Items that can be built against a fake first (C1 EZID, C2 ORCID) count as code work up to the live step.
4. **Uncommitted work**: `git status --short`. If the tree is dirty, the first recommendation is to finish/commit it (by explicit pathspec — see CLAUDE.md), never to start something new on top. Check `git worktree list` for in-flight branches too.
5. **Propose next 1–3**: rank by (a) `## The near-term order`, (b) whether it is testable locally without credentials (`make test`, `make e2e`), (c) whether it unblocks contributor onboarding. For each: the roadmap item, the first PR-sized step, what it needs from the operator (if anything), how it will be verified.
6. **Write back**: update markers/checkboxes; refresh the `## Where we actually are` table if a row changed (count from the tree: `ls config/*.yaml`, `grep -c "def test_" backend/tests/*.py`, `ls frontend/src/routes`); if the newest `## Shipped` block is more than ~2 weeks old, add a dated block listing shipped items in one line each with hashes. Keep edits surgical — the roadmap's prose is the plan, not a changelog.
7. End with: the proposal (≤3 items), the operator blockers in one line each, and `git diff --stat ROADMAP.md`.

## Rules

- A Phase A item is not BUILT until `make e2e` passes against the merged shape.
- "Parked, with reasons" items stay parked unless the reason is gone — check the reason, not the date.
- Never edit `old-backend/` or the sibling legacy repos while reconciling; they are reference.
