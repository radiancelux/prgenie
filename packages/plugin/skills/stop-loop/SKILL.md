---
name: stop-loop
description: Stop the implementor listen loop on this worktree. Halts watch, kills the /review-inbox shell, and leaves the local PR on disk. Use when the user runs /stop-loop or wants the implementor chat to stop listening.
disable-model-invocation: true
---

# Stop implementor listen

The developer is ending **this implementor chat's** inbox listen. Stay local. Do not push.

1. `prgenie watch stop` (MCP `watch_stop` if listed). Do not stall looking for MCP.
2. Kill the monitored shell / `/loop` you started for `/review-inbox` (`AGENT_LOOP_TICK_review-inbox`). Await that shell so a later completion notice does not re-arm you.
3. Do not implement. Do not address comments. The local PR stays on disk.
4. Confirm: watch is `halted reason=stop`. Do not `git push`. Do not `gh pr create`.
5. To publish, they must run `/export-local-pr`. To listen again, they run `/watch-review-inbox` or `/start-loop` after an **export** halt (not after this stop).
