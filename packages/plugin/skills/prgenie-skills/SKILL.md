---
name: prgenie-skills
description: Author PR Genie Cursor plugin skills (SKILL.md) so slash names stay unique and match the flywheel. Use when adding or editing packages/plugin/skills, plugin commands, or agent workflows for this repo.
---

# Author PR Genie skills

Cursor loads **plugin skills** and **plugin commands** as slash items. This plugin ships **skills only**. A matching `packages/plugin/commands/<name>.md` creates a **second** `/name` (the duplicate `/start` bug).

Follow [agentskills.io](https://agentskills.io/specification) and Cursor's skill format: `name` matches the folder, `description` is WHAT + WHEN (third person, trigger words), body under 500 lines, references one level deep.

## One job per skill

| Skill      | Who                    | Auto-invoke?                 |
| ---------- | ---------------------- | ---------------------------- |
| `loop`     | One steward per loop   | Yes (ticket / full flywheel) |
| `start`    | Implementor-only entry | Yes (ticket paste)           |
| `local-pr` | Create/update packets  | Yes                          |
| `review`   | Leaf reviewer          | Yes                          |
| `export`   | Publish                | No                           |

`/loop` is the only orchestrator (one steward, implementor/reviewer Tasks, export gate before human handoff). Do not add inbox/queue listen skills. `/start` stays implementor-only — do not blur it with `/loop`.

User-only skills set `disable-model-invocation: true` so the agent does not export from ambient context.

## Product rules to copy, not invent

Keep terminology fixed: **loop** (local PR packet), **address** (implementor) vs **resolve** (reviewer) vs **complete_review** (end of review). Do not push unless `/export`.

- `/loop` is steward only. If MCP / `steward_next` / `bind_steward` are unavailable, stop and tell the user to wait/retry — never CLI DIY.
- `/start` implements and stops at ready. It does not review and does not arm listen.
- Implementor acts only on **this worktree** when `changes_requested`.
- Implementor runs `prgenie ci` / MCP `run_ci` before ready and on CI-resume (`docs/ci-checks.md`). CI-resume is implementor → export gate again — no automatic re-review.

Edit `packages/plugin/rules/no-remote-pr.mdc` when the flywheel protocol changes — it is always applied. Skills stay the procedure; the rule stays the guardrail.

After skill edits, `pnpm link-plugin` and disable/re-enable PR Genie in Customize → Plugins so slash names refresh.
