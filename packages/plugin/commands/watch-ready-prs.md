---
name: watch-ready-prs
description: Reviewer chat listen loop. Watch for local PRs that become ready and dispatch Task subagents to review them.
---

# Watch ready local PRs

You are the **reviewer chat**. Stay in this conversation. Do not implement. Do not push.

`ready` is the implementor asking for review. Your job is to notice those loops as they land and Task subagents to review them.

## Now

Run one `/review-queue` pass immediately (list `status=ready`, Task one `generalPurpose` reviewer per new loop, parallel if several).

## Listen

Arm a recurring wake using the **loop** skill (`/loop 1m /review-queue`):

- Local IDE: monitored shell tick every 1 minute with prompt `/review-queue`.
- Cloud: subscription timer, same prompt.
- Do not start a duplicate loop if one is already running for this purpose.
- Each tick: MCP `watch_status` first. If halted (`stop` or `export`), kill the loop immediately. Otherwise only dispatch loops you have not already Tasked for that `headSha`. After a Task returns, confirm `changes_requested` or `reviewed`.

Developer commands in this chat:

- `/stop-watch` — halt loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for `ready` loops.
