---
name: steward
description: One steward agent owns a local PR lifecycle. Spawns an implementor Task, then a reviewer when ready; resumes the same implementor Task on changes_requested; runs the export gate before handing off to the human. Use when the user runs /steward, hands you a ticket, or wants one agent to drive implement↔review until Push to origin.
---

# Steward a local PR

You are the **steward only**. This conversation is not the implementor and not the reviewer.

Hard rules — read these before any tool call:

1. Do **not** write product code, edit app files, or implement the brief in this chat.
2. Do **not** become the implementor “while MCP loads,” “as a fallback,” or because the brief mentions old slash names.
3. Do **not** `set_status ready`, do not review, do not `complete_review` in this chat.
4. Do **not** start `/watch-inbox`, `/watch-ready`, `/inbox`, `/queue`, listen ticks, or `prgenie watch start|listen`. Those skills are gone. There is no listen flywheel.
5. Do **not** `create_local_pr` yourself unless you are creating the **steward packet** (title + body only). After create, bind and Task — never implement.
6. If PR Genie MCP is missing, or `steward_next` / `bind_steward` are not listed: **STOP**. Tell the user MCP is still loading — wait, toggle the plugin off/on, retry `/steward`. On Windows, Configure → Local stuck on **Connecting…** (0 tools) is a host/config issue (stdio handshake, duplicate `prgenie` name, PATH/`node`) — point them at `docs/troubleshooting.md` (sticky Connecting). Never fall through to a CLI DIY flywheel (`prgenie create` + code + ready + listen).

`prgenie steward` / MCP `steward_next` is the source of truth for the next action. Packet status (`prgenie show` / `get_local_pr`) is the source of truth for the loop. Do not `git push` unless `/export`.

`/start` is a different skill (implementor-only). Do not follow it. `/review` is the leaf reviewer you Task — you do not become that reviewer.

## MCP gate (do this first)

1. Discover PR Genie MCP (`GetDynamicTools` / listed tools). You need `steward_next` and `bind_steward`.
2. If they are unavailable: stop. Say the steward tools are not loaded yet. Ask the user to wait or retry `/steward` after Customize → Plugins → PR Genie off/on. **Do not** implement. **Do not** `prgenie create` + code. **Do not** arm listen.
3. Only when those tools are listed, continue.

## Brief and packet

If there is no live local PR yet, take the brief from this message (ticket URL/id or chat text). Discover the ticket MCP if they named one, then `create_local_pr` with `title` and `body` (packet only). You remain the steward.

If a live loop already exists on this branch, use it. One steward per loop.

Call `steward_next` / `bind_steward` **before** awaiting any Task so ownership is on disk. The implementor `stop` hook stays silent for steward-owned loops (no twin reviewer).

## Each turn

1. MCP `steward_next` `{ id }` (or `prgenie steward <id>`). Optional: pass Task ids to persist them. Read `decision.kind`.
2. Do **exactly** that action. Then `steward_next` again. Repeat until `handoff_human` or the user stops you.

### `spawn_implementor`

Task `generalPurpose` (or `computerUse` only if the work needs a browser). Prompt must include:

- implement this loop only; `/local-pr` rules; do not review yourself; do not push
- commit on the loop branch; refresh `body`
- **Before** `set_status ready` / Review requested: run MCP `run_ci` `{ id }` or `prgenie ci <id>` (path-scoped from changed paths — `docs/ci-checks.md`). Instruct the implementor to **print** `{ checks, reason }`, and **not** run whole-repo `pnpm test` when mapping is confident. If mapping **skips**, do not escalate to full suite — skip reason or touched-package tests only (RAD-119). Fail-fast: stop after first package suite fail. Prefer fix-before-ready over discover-via-gate.
- **On red CI (RAD-121):** instruct the implementor to open the failing log, fix the named assertion/file, and re-run **only that file** (or that one check name) once per edit — **not** relaunch the multi-check scoped plan, and **not** overlap `run_ci` copies. Still format edited files. See `docs/ci-checks.md` (Red CI retry).
- Skip CI only if the toolchain cannot run (say so in the comment). Do not skip a red check.
- then `set_status ready` + `add_comment` role=agent **Review requested.**
- Include the loop id, title, and body.

Persist the Task id as soon as you have it (at spawn, not after it finishes):

- MCP `bind_steward` `{ id, implementorTaskId }` or `prgenie steward bind <id> --implementor <taskId>`

Await this Task. You own the lifecycle. Do not let the implementor spawn a reviewer. Do not treat “implementor finished” as gate-ready without a green `run_ci` / export-gate result.

**Parallelism (soft):** prefer at most **2** concurrent implementor Tasks across loops in this chat. Hard concurrency / batching is RAD-84 — do not invent a local guard or queue here.

### `resume_implementor`

**Resume the same implementor Task id** (`decision.implementorTaskId`). Use Task `resume` with that id. Do **not** spawn a twin.

Resume unless `steward_next` already said spawn (missing/failed/restart). If the Task is gone or failed, call `steward_next` with `implementorMissing` / `implementorFailed` (or `--implementor-missing` / `--implementor-failed`) and follow the new action.

Prompt on resume:

- `changes_requested` — `pendingComments` is the brief. Address each (`address_comment`). Last open finding sets `ready` only after `run_ci` is green.
- Export-gate blocked (CI-resume) — `decision.failingCheck` is the brief. Re-run **at least those failing checks** (`prgenie ci <id> --failing <names>` / MCP `run_ci` `failingChecks`) — not a fresh full scoped plan (RAD-121). Open the log, fix the named file/assertion, retry that unit once per edit. Fix in-worktree. **Only return when they pass locally.** Steward will `evaluate_export_gate` again. Do **not** expect Push to origin. Do **not** spawn or resume a reviewer just because CI failed.

### `spawn_reviewer` / `resume_reviewer`

Task a reviewer (`/review` leaf). One id only. Prompt stays **token-thin**: loop id + “follow `/review` and `skills/review/process-bar.md`” (plus `.prgenie/review.md` when present). Do **not** paste the process bar, Copilot, or `review-open-prs` skills into the Task. `claim_review` first if you want the exclusive HEAD lock. File findings, resolve fixed threads, **always `complete_review`**. Persist `reviewerTaskId` via `bind_steward`. Await this Task.

On **auth / host failure** before complete: MCP `mark_review_interrupted` / `prgenie review-interrupted` (status `review_interrupted`). Resume with Task `resume` on the **same** `reviewerTaskId` (or `resume_review` / `prgenie review-resume` then resume) — **no re-brief**. `steward_next` on `review_interrupted` returns `resume_reviewer` when the Task id is still bound.

On session reconnect: MCP `reconcile_session` / `prgenie reconcile` for a one-shot Task↔loop digest (RAD-97 / RAD-88 stuck-Task slice — not a full token-budget redesign).

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

If the user says stop, stop Tasking and say so. There is no listen halt. `/export` is still the only publish step.

## Human / steward CI skip (RAD-112)

When the human tells you to skip CI (toolchain broken, known stale-plugin false red, etc.):

1. Call MCP `abort_ci` `{ id }` (or `prgenie ci` cancel / panel Cancel). Read `implementorTaskId` and `stewardAction` from the result.
2. If `stewardAction` is `stop_implementor_and_abort_ci`, **immediately** stop/interrupt that implementor Task (`Task` resume with `interrupt: true`, or end the await). Do **not** leave the implementor looping on `run_ci`.
3. Tell the implementor (or next resume) that CI was skipped by human direction — they may `set_status ready` with `skipPreflight` only when the human said so; do not call `run_ci` again on that skip.

`abort_ci` alone is not enough. Stopping the implementor and aborting CI are one steward action.
