---
name: watch-inbox
description: Implementor listen loop for this worktree's local PR. Watches for complete_review → changes_requested and addresses open findings. Use when the user runs /watch-inbox or wants this chat to pick up reviewer comments as they land.
disable-model-invocation: true
---

# Watch review inbox

**Transitional.** Prefer **`/loop`** (one steward, resume the same implementor Task, export gate before Push to origin). Use this listen only when the user explicitly wants the two-chat inbox.

You are the **implementor** on this worktree. Stay in this conversation. Do not review your own loop. Do not push.

`changes_requested` is how review completion reaches you — **for this worktree's local PR only**. Reviewer comments on a still-`ready` loop are in progress — wait for `complete_review`. Then `pendingComments` is the brief. Never implement a different loop just because it appears in the repo inbox.

## Now

If this branch has **no** live local PR yet, the user's message is the brief — follow `/start` (ticket MCP or chat text), then come back here. Do not sit idle on `main` waiting for a packet.

Otherwise run `prgenie watch start inbox` (MCP `watch_start` `role=inbox` if listed) so a prior `/stop` or idle/max DONE can resume **this lane only**. Do not `prgenie watch start` with no role. Then run one `/inbox` pass.

## Listen

Arm an **idle-timeout** listen with the built-in CLI (do **not** hand-roll `for`/`Start-Sleep` loops). Arm **one** listen process for this chat. Never start a second `watch listen` while that process is still running.

```powershell
node packages/cli/dist/prgenie.cjs watch listen inbox --idle 30m --max 8h --interval 60
```

Or `prgenie watch listen inbox` if the CLI is on PATH (same defaults). Notify on `^AGENT_LOOP_(TICK|DONE)_review-inbox`. Listen prints **TICK only when the inbox fingerprint changes** — not every interval. It still polls internally, exits early if the inbox lane is halted, exits after **30m with no inbox activity**, or after the **8h** wall ceiling. Then run `/stop`.

- Cloud: prefer `prgenie watch listen inbox` in the cloud shell (idle/max built in). If you must use a subscription timer, unsubscribe when DONE fires with `reason` idle/max/stop/export — do not hard-cap at 60 fires.
- Do not start a duplicate loop if one is already running for this purpose.
- Each **TICK**: the listen process is **still running**. **Do not re-arm listen. Do not start another `watch listen`.** MCP `watch_status` if listed (read **`inbox`**, not the combined `halted` flag), otherwise `node packages/cli/dist/prgenie.cjs watch inbox`. Do not stall looking for MCP. `listening` continues. `halted reason=stop` on **inbox** → kill this listen loop; the developer ended it (the reviewer queue may still be listening). `halted reason=export` → do not implement that packet. Do **not** `prgenie watch start` on a tick (no role, and not `start inbox`) — only this `/watch-inbox` command starts the inbox lane. A different live loop on this checkout is not enough. `create_local_pr` resumes export-halted lanes after that id is archived or gone; it does not clear a stop halt. Otherwise only act when `prgenie inbox` shows **this worktree's** loop (`changes_requested` with new open findings). Never pick another loop.
- Each **DONE** (or the listen process exits): run `/stop` (inbox only). Tell the developer why from the DONE payload (`idle` = quiet 30m, `max` = 8h ceiling, `stop`/`export` = halt). They re-run `/watch-inbox` to continue. Do not re-arm. Do **not** `/unwatch` — that would halt the reviewer queue too.

Developer commands in this chat:

- `/stop` — halt and kill this inbox listen.
- `/unwatch` — halt both listen loops, stay local.
- `/export` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for review comments on the current branch's local PR, and that listen stops after **30 minutes of inactivity** (or 8h max) unless they re-run it.
