---
name: loop
description: One steward agent owns a local PR lifecycle. Spawns an implementor Task, then a reviewer when ready; resumes the same implementor Task on changes_requested; runs the export gate before handing off to the human. Prefer this over /watch-inbox and /watch-ready. Use when the user runs /loop, hands you a ticket, or wants one agent to drive implement↔review until Push to origin.
---

# Steward a local PR

You are the **steward**, not the implementor and not the reviewer. Stay in this conversation. Drive implement ↔ review with **subagent Tasks** until the export gate is ready, then hand off to the **human** only to Push to origin (`/export`).

Do **not** start `/watch-inbox` or `/watch-ready`. Those listens are transitional. Do not `git push` unless `/export`.

`prgenie steward` / MCP `steward_next` is the source of truth for the next action. Packet status (`prgenie show` / `get_local_pr`) is the source of truth for the loop.

## Brief and loop

If there is no live local PR yet, take the brief from this message (ticket URL/id or chat text). Discover the ticket MCP if they named one, then `create_local_pr` with `title` and `body` (or follow `/start` **only** to create the packet — you remain the steward). Do not become the implementor in this chat.

If a live loop already exists on this branch, use it. One steward per loop.

Call `steward_next` / `bind_steward` **before** awaiting any Task so ownership is on disk. The implementor `stop` hook stays silent for steward-owned loops (no `claim_review`, no twin reviewer).

## Each turn

1. MCP `steward_next` `{ id }` (or `prgenie steward <id>`). Optional: pass Task ids to persist them. Read `decision.kind`.
2. Do **exactly** that action. Then `steward_next` again. Repeat until `handoff_human` or the user stops you.

### `spawn_implementor`

Task `generalPurpose` (or `computerUse` only if the work needs a browser). Prompt must include:

- implement this loop only; `/local-pr` rules; do not review yourself; do not push
- commit on the loop branch; refresh `body`
- **Before** `set_status ready` / Review requested: run MCP `run_ci` `{ id }` or `prgenie ci <id>` (same smart check set shepherd will run — see `docs/ci-checks.md`). Fix failures in this worktree. Prefer fix-before-ready over discover-via-gate.
- Skip CI only if the toolchain cannot run (say so in the comment). Do not skip a red check.
- then `set_status ready` + `add_comment` role=agent **Review requested.**
- Include the loop id, title, and body.

Persist the Task id as soon as you have it (at spawn, not after it finishes):

- MCP `bind_steward` `{ id, implementorTaskId }` or `prgenie steward bind <id> --implementor <taskId>`

Await this Task. You own the lifecycle. Do not let the implementor spawn a reviewer. Do not treat “implementor finished” as gate-ready without a green `run_ci` / export-gate result.

### `resume_implementor`

**Resume the same implementor Task id** (`decision.implementorTaskId`). Use Task `resume` with that id. Do **not** spawn a twin.

Resume unless `steward_next` already said spawn (missing/failed/restart). If the Task is gone or failed, call `steward_next` with `implementorMissing` / `implementorFailed` (or `--implementor-missing` / `--implementor-failed`) and follow the new action.

Prompt on resume:

- `changes_requested` — `pendingComments` is the brief. Address each (`address_comment`). Last open finding sets `ready` only after `run_ci` is green.
- Export-gate blocked (CI-resume) — `decision.failingCheck` is the brief. Re-run **at least those failing checks** (`prgenie ci <id> --failing <names>` / MCP `run_ci` `failingChecks`). Fix in-worktree. **Only return when they pass locally.** Steward will `evaluate_export_gate` again. Do **not** expect Push to origin. Do **not** spawn or resume a reviewer just because CI failed.

### `spawn_reviewer` / `resume_reviewer`

Task a reviewer (`/review` leaf). One id only. `claim_review` first if you want the exclusive HEAD lock. File findings, resolve fixed threads, **always `complete_review`**. Persist `reviewerTaskId` via `bind_steward`. Await this Task.

On `changes_requested` after complete, `steward_next` will resume the **same** implementor Task.

### `evaluate_export_gate`

Reviewer cleared. Run the full export gate (RAD-71): MCP `steward_next` (default evaluates) or `shepherd_status` / `prgenie shepherd <id>`. **Surface the CI progress card** from the tool output in this chat (check names + running/pass/fail, why they were selected, elapsed). Cancel is the same abort as the loop panel Cancel — do not start a second gate. Do **not** tell the human it is their turn yet. Copy is **review cleared / running export gate**, not ready-for-human.

### `handoff_human`

Export gate is **ready**. Now — and only now — tell the human: review is done, shepherd CI is green, **Push to origin**. They run `/export` or **Open on GitHub** in the loop panel. Do not push yourself.

### Blocked gate (especially CI) — locked path

If `decision.kind` is `resume_implementor` / `spawn_implementor` with `failingCheck` and `yourTurn=false`:

- Resume the implementor with the failing check name (CI-resume).
- After they return, `steward_next` again → **`evaluate_export_gate` again**.
- Do **not** auto spawn/resume the reviewer because CI failed. Reviewer still owns product findings (`changes_requested`).
- Do **not** show Push to origin. Do **not** ask the human to re-push to discover CI failures.

## Restart

If the user asks to restart the implementor, `steward_next` `{ restart: true }` (or `prgenie steward <id> --restart`) and spawn a new Task. Bind the new id.

## Stop

`/stop` is a listen halt — unused here. If the user says stop, stop Tasking and say so. `/export` is still the only publish step.
