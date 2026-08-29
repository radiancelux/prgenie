---
name: watch-ready-prs
description: Reviewer chat listen loop. Watches for local PRs that become ready and dispatches Task subagents to review them. Use when the user runs /watch-ready-prs or wants this chat to pick up ready loops as they land.
disable-model-invocation: true
---

# Watch ready local PRs

You are the **reviewer chat**. Stay in this conversation. Do not implement. Do not push.

`ready` is the implementor asking for review. Your job is to notice those loops as they land and Task subagents to review them. Do not sit on a Task waiting for it to return. Packet status (`prgenie queue` / `prgenie show`) is the source of truth, not a Task summary.

## Now

Run one `/review-queue` pass immediately (list `status=ready`, Task one `generalPurpose` reviewer per new loop, parallel if several). Then keep listening.

## Listen

Arm a **capped** recurring wake using the **loop** skill (`/loop 1m /review-queue`). **Max 60 ticks** (~1 hour). Then halt. Do not `while ($true)` forever.

Local IDE (PowerShell) — one shell, unique sentinel, `notify_on_output` on `^AGENT_LOOP_(TICK|DONE)_review-queue`:

```powershell
$max = 60
for ($i = 1; $i -le $max; $i++) {
  Start-Sleep -Seconds 60
  Write-Output 'AGENT_LOOP_TICK_review-queue {"prompt":"/review-queue"}'
}
Write-Output 'AGENT_LOOP_DONE_review-queue {"prompt":"/stop-watch"}'
```

- Cloud: subscription timer, same `/review-queue` prompt, **unsubscribe after 60 fires**.
- Do not start a duplicate loop if one is already running for this purpose.
- Each **TICK**: MCP `watch_status` if listed, otherwise `prgenie watch`. If `halted reason=stop`, kill the loop immediately. If `halted reason=export`, the last packet shipped — stop this listen pass. A new implementor loop (`create_local_pr`) resumes watch after that export id is archived or missing; re-arm if you killed the shell **and** watch is `listening`. Otherwise only dispatch loops you have not already Tasked for that `headSha`. Do not await those Tasks. Do not `complete_review` in this chat. If a Task later returns here, ignore its status text — `prgenie show` is the handoff.
- Each **DONE** (or the shell exits after the cap): run `/stop-watch`. Tell the developer the listen cap hit ~1 hour. They re-run `/watch-ready-prs` to continue. Do not re-arm.

Developer commands in this chat:

- `/stop-review` — halt and kill this queue listen.
- `/stop-watch` — halt both listen loops, stay local.
- `/export-local-pr` — halt loops, push, open the GitHub PR at origin.

When the user says stop, kill the loop. Confirm it has stopped.

Tell the user this chat is listening for `ready` loops, and that listen stops after 60 minutes unless they re-run it.
