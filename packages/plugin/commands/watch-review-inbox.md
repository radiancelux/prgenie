---
name: watch-review-inbox
description: Implementor chat listen loop. If there is no loop yet, take a ticket or chat brief via /start-loop. Then watch for reviewer comments on this worktree's local PR.
---

# Watch review inbox

You are the **implementor** on this worktree. Stay in this conversation. Do not review your own loop. Do not push.

`changes_requested` is how review completion reaches you — **for this worktree's local PR only**. Reviewer comments on a still-`ready` loop are in progress — wait for `complete_review`. Then `pendingComments` is the brief. Never implement a different loop just because it appears in the repo inbox.

## Now

If this branch has **no** live local PR yet, the user's message is the brief — follow `/start-loop` (ticket MCP or chat text), then come back here. Do not sit idle on `main` waiting for a packet.

Otherwise run one `/review-inbox` pass immediately.

## Listen

Arm a recurring wake using the **loop** skill (`/loop 1m /review-inbox`):

- Local IDE: monitored shell tick every 1 minute with prompt `/review-inbox`.
- Cloud: subscription timer, same prompt.
- Do not start a duplicate loop if one is already running for this purpose.
- Each tick: MCP `watch_status` if listed, otherwise `node packages/cli/dist/prgenie.cjs watch`. Do not stall looking for MCP. `listening` continues. `halted reason=stop` → kill the listen loop; the developer ended it. `halted reason=export` → that packet shipped; do not implement it. A new `/start-loop` / `create_local_pr` resumes watch. If this checkout already has a **live** loop and watch is still export-halted, `prgenie watch start`, then continue. Otherwise only act when `prgenie inbox` shows **this worktree's** loop (`changes_requested` with new open findings). Never pick another loop.

Developer commands in this chat:

- `/stop-watch` — halt loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for review comments on the current branch's local PR.
