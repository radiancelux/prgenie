---
name: prgenie-skills
description: Author PR Genie Cursor plugin skills (SKILL.md) so slash names stay unique and match the flywheel. Use when adding or editing packages/plugin/skills, plugin commands, or agent workflows for this repo.
---

# Author PR Genie skills

Cursor loads **plugin skills** and **plugin commands** as slash items. This plugin ships **skills only**. A matching `packages/plugin/commands/<name>.md` creates a **second** `/name` (the duplicate `/start` bug).

Follow [agentskills.io](https://agentskills.io/specification) and Cursor's skill format: `name` matches the folder, `description` is WHAT + WHEN (third person, trigger words), body under 500 lines, references one level deep.

## One job per skill

| Skill                              | Who                        | Auto-invoke?                          |
| ---------------------------------- | -------------------------- | ------------------------------------- |
| `loop`                             | One steward per loop       | Yes (ticket / full flywheel)          |
| `start`                            | Implementor-only entry     | Yes (ticket paste)                    |
| `local-pr`                         | Create/update packets      | Yes                                   |
| `review`                           | Leaf + orchestrator review | Yes                                   |
| `watch-inbox` / `watch-ready`      | Listen (transitional)      | No (`disable-model-invocation: true`) |
| `inbox` / `queue`                  | One tick                   | No                                    |
| `stop` / `stop-review` / `unwatch` | Halt listen                | No                                    |
| `export`                           | Publish                    | No                                    |

Prefer **`/loop`** for agent orchestration (one steward, implementor/reviewer Tasks, export gate before human handoff). Inbox/queue listen skills stay for the transitional two-chat path.

User-only skills set `disable-model-invocation: true` so the agent does not start a listen loop or export from ambient context.

## Product rules to copy, not invent

Keep terminology fixed: **loop** (local PR packet), **halt** (`stop` vs `export`), **address** (implementor) vs **resolve** (reviewer) vs **complete_review** (end of review). Do not push unless `/export`.

- Export halt resumes only when that export id is **missing or archived**. Id inequality is not enough. Stop halt never auto-resumes.
- Listen shells use **idle timeout** (default 30m quiet) with an **8h** wall ceiling, then `/stop` or `/stop-review` for that chat only. Never `while ($true)`. Never `/unwatch` from an idle/max DONE.
- `prgenie watch start inbox` / `start queue` resume one lane. `/watch-inbox` and `/watch-ready` start only their lane. Ticks never `watch start`.
- Implementor acts only on **this worktree** when `changes_requested`. Reviewer Tasks must not be awaited.
- Implementor runs `prgenie ci` / MCP `run_ci` before ready and on CI-resume (`docs/ci-checks.md`). CI-resume is implementor → export gate again — no automatic re-review.

Edit `packages/plugin/rules/no-remote-pr.mdc` when the flywheel protocol changes — it is always applied. Skills stay the procedure; the rule stays the guardrail.

After skill edits, `pnpm link-plugin` and disable/re-enable PR Genie in Customize → Plugins so slash names refresh.
