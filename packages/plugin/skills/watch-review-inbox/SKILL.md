---
name: watch-review-inbox
description: Implementor listen loop for this worktree's local PR. Watches for complete_review → changes_requested and addresses open findings. Use when the user runs /watch-review-inbox or wants this chat to pick up reviewer comments as they land.
disable-model-invocation: true
---

# Watch review inbox

You are the **implementor** on this worktree. Stay in this conversation. Do not review your own loop. Do not push.

`changes_requested` is how review completion reaches you — **for this worktree's local PR only**. Reviewer comments on a still-`ready` loop are in progress — wait for `complete_review`. Then `pendingComments` is the brief. Never implement a different loop just because it appears in the repo inbox.

## Now

If this branch has **no** live local PR yet, the user's message is the brief — follow `/start-loop` (ticket MCP or chat text), then come back here. Do not sit idle on `main` waiting for a packet.

Otherwise run one `/review-inbox` pass immediately.

## Listen

Arm a **capped** recurring wake using the **loop** skill (`/loop 1m /review-inbox`). **Max 60 ticks** (~1 hour). Then halt. Do not `while ($true)` forever.

Local IDE (PowerShell) — one shell, unique sentinel, `notify_on_output` on `^AGENT_LOOP_(TICK|DONE)_review-inbox`:

```powershell
$max = 60
for ($i = 1; $i -le $max; $i++) {
  Start-Sleep -Seconds 60
  Write-Output 'AGENT_LOOP_TICK_review-inbox {"prompt":"/review-inbox"}'
}
Write-Output 'AGENT_LOOP_DONE_review-inbox {"prompt":"/stop-loop"}'
```

- Cloud: subscription timer, same `/review-inbox` prompt, **unsubscribe after 60 fires**.
- Do not start a duplicate loop if one is already running for this purpose.
- Each **TICK**: MCP `watch_status` if listed (read **`inbox`**, not the combined `halted` flag), otherwise `node packages/cli/dist/prgenie.cjs watch inbox`. Do not stall looking for MCP. `listening` continues. `halted reason=stop` on **inbox** → kill this listen loop; the developer ended it (the reviewer queue may still be listening). `halted reason=export` → do not implement that packet. Do **not** `prgenie watch start` unless the export id is missing or archived. A different live loop on this checkout is not enough. `create_local_pr` resumes only after that id is archived or gone. Otherwise only act when `prgenie inbox` shows **this worktree's** loop (`changes_requested` with new open findings). Never pick another loop.
- Each **DONE** (or the shell exits after the cap): run `/stop-loop` (inbox only). Tell the developer the implementor listen cap hit ~1 hour. They re-run `/watch-review-inbox` to continue. Do not re-arm. Do **not** `/stop-watch` — that would halt the reviewer queue too.

Developer commands in this chat:

- `/stop-loop` — halt and kill this inbox listen.
- `/stop-watch` — halt both listen loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for review comments on the current branch's local PR, and that listen stops after 60 minutes unless they re-run it.
