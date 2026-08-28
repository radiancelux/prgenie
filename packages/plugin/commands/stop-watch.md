---
name: stop-watch
description: Developer command. Halt the reviewer and implementor listen loops. Does not push or open a GitHub PR.
---

# Stop watch loops

The developer is ending the local review listen loop.

1. MCP `watch_stop` (or `prgenie watch stop`).
2. Kill any `/loop` / monitored shell you started for `/review-queue` or `/review-inbox`.
3. Confirm: loops are halted. Do not `git push`. Do not `gh pr create`.
4. If they also want the GitHub PR, they must run `/export-local-pr`.
