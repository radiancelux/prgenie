---
name: prgenie-skills
description: Author PR Genie Cursor plugin skills (SKILL.md) so slash names stay unique and match the flywheel. Use when adding or editing packages/plugin/skills, plugin commands, or agent workflows for this repo.
---

# Author PR Genie skills

Cursor loads **plugin skills** and **plugin commands** as slash items. This plugin ships **skills only**. A matching `packages/plugin/commands/<name>.md` creates a **second** `/name` (the duplicate `/start-loop` bug).

Follow [agentskills.io](https://agentskills.io/specification) and Cursor's skill format: `name` matches the folder, `description` is WHAT + WHEN (third person, trigger words), body under 500 lines, references one level deep.

## One job per skill

| Skill | Who | Auto-invoke? |
| --- | --- | --- |
| `start-loop` | Implementor entry | Yes (ticket paste) |
| `local-pr` | Create/update packets | Yes |
| `review-local-pr` | Leaf + orchestrator review | Yes |
| `watch-review-inbox` / `watch-ready-prs` | Listen | No (`disable-model-invocation: true`) |
| `review-inbox` / `review-queue` | One tick | No |
| `stop-loop` / `stop-review` / `stop-watch` | Halt listen | No |
| `export-local-pr` | Publish | No |

User-only skills set `disable-model-invocation: true` so the agent does not start a listen loop or export from ambient context.

## Product rules to copy, not invent

Keep terminology fixed: **loop** (local PR packet), **halt** (`stop` vs `export`), **address** (implementor) vs **resolve** (reviewer) vs **complete_review** (end of review). Do not push unless `/export-local-pr`.

- Export halt resumes only when that export id is **missing or archived**. Id inequality is not enough. Stop halt never auto-resumes.
- Listen shells use **idle timeout** (default 30m quiet) with an **8h** wall ceiling, then `/stop-loop` or `/stop-review` for that chat only. Never `while ($true)`. Never `/stop-watch` from an idle/max DONE.
- `prgenie watch start inbox` / `start queue` resume one lane. `/watch-review-inbox` and `/watch-ready-prs` start only their lane. Ticks never `watch start`.
- Implementor acts only on **this worktree** when `changes_requested`. Reviewer Tasks must not be awaited.

Edit `packages/plugin/rules/no-remote-pr.mdc` when the flywheel protocol changes — it is always applied. Skills stay the procedure; the rule stays the guardrail.

After skill edits, `pnpm link-plugin` and disable/re-enable PR Genie in Customize → Plugins so slash names refresh.
