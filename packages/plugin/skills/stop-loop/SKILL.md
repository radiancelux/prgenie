---
name: stop-loop
description: Stop the implementor listen loop on this worktree. Halts only the inbox lane, kills the /review-inbox shell, and leaves the reviewer queue running. Use when the user runs /stop-loop or wants the implementor chat to stop listening.
disable-model-invocation: true
---

# Stop implementor listen

The developer is ending **this implementor chat's** inbox listen. Stay local. Do not push.

Do **not** run `prgenie watch stop` (that is both lanes). Do **not** halt the reviewer queue.

1. `prgenie watch stop inbox` (MCP `watch_stop` with `role=inbox` if listed). Do not stall looking for MCP.
2. Kill the monitored shell / `/loop` you started for `/review-inbox` (`AGENT_LOOP_TICK_review-inbox`). Await that shell so a later completion notice does not re-arm you.
3. Do not implement. Do not address comments. The local PR stays on disk.
4. Confirm: `prgenie watch inbox` is `halted reason=stop` and `prgenie watch queue` is still `listening` (unless they also stopped review). Do not `git push`. Do not `gh pr create`.
5. To publish, they must run `/export-local-pr`. To listen again, they run `/watch-review-inbox`. Inbox stop never auto-resumes.
