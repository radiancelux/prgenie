---
name: stop-review
description: Stop the reviewer listen loop. Halts only the queue lane, kills the /review-queue shell, and leaves the implementor inbox running. Use when the user runs /stop-review or wants the reviewer chat to stop listening.
disable-model-invocation: true
---

# Stop reviewer listen

The developer is ending **this reviewer chat's** queue listen. Stay local. Do not push.

Do **not** run `prgenie watch stop` (that is both lanes). Do **not** halt the implementor inbox.

1. `prgenie watch stop queue` (MCP `watch_stop` with `role=queue` if listed). Do not stall looking for MCP.
2. Kill the monitored shell / `/loop` you started for `/review-queue` (`AGENT_LOOP_TICK_review-queue`). Await that shell so a later completion notice does not re-arm you.
3. Do not Task more reviewers. Do not `complete_review` in this chat. In-flight leaf Tasks may still finish — packet status is the source of truth.
4. Confirm: `prgenie watch queue` is `halted reason=stop` and `prgenie watch inbox` is still `listening` (unless they also stopped the implementor). Do not `git push`. Do not `gh pr create`.
5. To publish, they must run `/export-local-pr`. To listen again, they run `/watch-ready-prs`. Queue stop never auto-resumes.
