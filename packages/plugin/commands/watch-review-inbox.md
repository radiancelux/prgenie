---
name: watch-review-inbox
description: Implementor chat listen loop. Watch for reviewer comments on this worktree's local PR and treat them as the brief.
---

# Watch review inbox

You are the **implementor** on this worktree. Stay in this conversation. Do not review your own loop. Do not push.

Reviewer `role=reviewer` comments (and human comments) are how review completion reaches you. `pendingComments` is the brief.

## Now

Run one `/review-inbox` pass immediately.

## Listen

Arm a recurring wake using the **loop** skill (`/loop 1m /review-inbox`):

- Local IDE: monitored shell tick every 1 minute with prompt `/review-inbox`.
- Cloud: subscription timer, same prompt.
- Do not start a duplicate loop if one is already running for this purpose.
- Each tick: MCP `watch_status` first. If halted (`stop` or `export`), kill the loop immediately. Otherwise only act when new `pendingComments` exist.

Developer commands in this chat:

- `/stop-watch` — halt loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for review comments on the current branch's local PR.
