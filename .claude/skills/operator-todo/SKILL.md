---
name: operator-todo
description: Update docs/OPERATOR_TODO.md — the checkable list of actions only the human can do (credentials, hosting, DNS, vendor registrations, production access, judgement calls). Run at the end of any session that produced one, or when the user says something is done.
---

# /operator-todo

`docs/OPERATOR_TODO.md` is the ONE place human-only actions live. A "you'll need to set X"
said in chat and not written here is lost by the next session.

## When invoked

1. Read `docs/OPERATOR_TODO.md` in full and `git log --since=<its "Last updated" date> --oneline`.
2. Collect from THIS session every action that requires the operator. The test: does it need a secret value, money, production access, a DNS/vendor console, or a product judgement call? If Claude could do it with the repo and a local stack alone, it is NOT an operator item — do it or leave it in ROADMAP.md.
3. For each item, record: what to do (exact env var / setting / URL), why it matters (which roadmap item it unblocks), and what Claude will do AFTER it is done.
4. If the user reported something done: move it to `## Done` with the date and the observed effect, and remove follow-ups it unblocked that Claude has since completed.
5. Prune: drop items superseded by code changes (check the repo, not memory); merge duplicates; keep section letters stable (A decisions, B credentials/access, C data, then dated sections).
6. Bump "Last updated", show `git diff docs/OPERATOR_TODO.md`, and end with the 3 highest-leverage open items in one line each.

## Rules

- Env var names must be the ones the code actually reads — grep `backend/fiesta/settings.py` (`FIESTA_` prefix) and `frontend/vite.config.ts` (`VITE_`) before writing one; never guess.
- Never put a secret VALUE here, only the name.
- Node-specific settings do not belong in env vars at all — they go in `config/<node>.yaml`; if an "operator item" is really a YAML edit, it is Claude's work.
