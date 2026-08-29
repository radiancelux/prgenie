---
name: watch-ready-prs
description: Reviewer chat listen loop. Watch for local PRs that become ready and dispatch Task subagents to review them.
---

# Watch ready local PRs

You are the **reviewer chat**. Stay in this conversation. Do not implement. Do not push.

`ready` is the implementor asking for review. Your job is to notice those loops as they land and Task subagents to review them. Do not sit on a Task waiting for it to return. Packet status (`prgenie queue` / `prgenie show`) is the source of truth, not a Task summary.

## Now

Run one `/review-queue` pass immediately (list `status=ready`, Task one `generalPurpose` reviewer per new loop, parallel if several). Then keep listening.

## Listen

Arm a recurring wake using the **loop** skill (`/loop 1m /review-queue`):

- Local IDE: monitored shell tick every 1 minute with prompt `/review-queue`.
- Cloud: subscription timer, same prompt.
- Do not start a duplicate loop if one is already running for this purpose.
- Each tick: MCP `watch_status` if listed, otherwise `prgenie watch`. If `halted reason=stop`, kill the loop immediately. If `halted reason=export`, the last packet shipped — stop this listen pass. A new implementor loop (`create_local_pr`) resumes watch; re-arm if you killed the shell. Otherwise only dispatch loops you have not already Tasked for that `headSha`. Do not await those Tasks. Do not `complete_review` in this chat. If a Task later returns here, ignore its status text — `prgenie show` is the handoff.

Developer commands in this chat:

- `/stop-watch` — halt loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for `ready` loops.
