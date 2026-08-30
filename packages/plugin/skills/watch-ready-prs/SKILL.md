---
name: watch-ready-prs
description: Reviewer chat listen loop. Watches for local PRs that become ready and dispatches Task subagents to review them. Use when the user runs /watch-ready-prs or wants this chat to pick up ready loops as they land.
disable-model-invocation: true
---

# Watch ready local PRs

You are the **reviewer chat**. Stay in this conversation. Do not implement. Do not push.

`ready` is the implementor asking for review. Your job is to notice those loops as they land and Task subagents to review them. Do not sit on a Task waiting for it to return. Packet status (`prgenie queue` / `prgenie show`) is the source of truth, not a Task summary.

## Now

Run `prgenie watch start queue` (MCP `watch_start` `role=queue` if listed) so a prior `/stop-review` or idle/max DONE can resume **this lane only**. Do not `prgenie watch start` with no role. Then run one `/review-queue` pass immediately (list `status=ready`, Task one `generalPurpose` reviewer per new loop, parallel if several). Then keep listening.

## Listen

Arm an **idle-timeout** listen with the built-in CLI (do **not** hand-roll `for`/`Start-Sleep` loops):

```powershell
node packages/cli/dist/prgenie.cjs watch listen queue --idle 30m --max 8h --interval 60
```

Or `prgenie watch listen queue` if the CLI is on PATH (same defaults). Notify on `^AGENT_LOOP_(TICK|DONE)_review-queue`. The process prints the same TICK/DONE sentinels, exits early if the queue lane is halted, exits after **30m with no queue activity**, or after the **8h** wall ceiling. Then run `/stop-review`.

- Cloud: prefer `prgenie watch listen queue` in the cloud shell (idle/max built in). If you must use a subscription timer, unsubscribe when DONE fires with `reason` idle/max/stop/export — do not hard-cap at 60 fires.
- Do not start a duplicate loop if one is already running for this purpose.
- Each **TICK**: MCP `watch_status` if listed (read **`queue`**, not the combined `halted` flag), otherwise `prgenie watch queue`. If `halted reason=stop` on **queue**, kill this loop immediately (the implementor inbox may still be listening). If `halted reason=export`, the last packet shipped — stop this listen pass. Do **not** `prgenie watch start` on a tick (no role, and not `start queue`) — only this `/watch-ready-prs` command starts the queue lane. A new implementor loop (`create_local_pr`) resumes export-halted lanes after that id is archived or missing; it does not clear a stop halt. Re-arm only if you killed the shell **and** `prgenie watch queue` is `listening`. Otherwise only dispatch loops you have not already Tasked for that `headSha`. Do not await those Tasks. Do not `complete_review` in this chat. If a Task later returns here, ignore its status text — `prgenie show` is the handoff.
- Each **DONE** (or the listen process exits): run `/stop-review` (queue only). Tell the developer why from the DONE payload (`idle` / `max` / `stop` / `export`). They re-run `/watch-ready-prs` to continue. Do not re-arm. Do **not** `/stop-watch` — that would halt the implementor inbox too.

Developer commands in this chat:

- `/stop-review` — halt and kill this queue listen.
- `/stop-watch` — halt both listen loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for `ready` loops, and that listen stops after **30 minutes of inactivity** (or 8h max) unless they re-run it.
