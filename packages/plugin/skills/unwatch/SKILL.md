---
name: unwatch
description: Halt both reviewer and implementor listen loops without publishing. Use when the user runs /unwatch or wants all PR Genie listen loops to stop and stay local.
disable-model-invocation: true
---

# Stop watch loops

The developer is ending **both** local review listen loops (implementor inbox and reviewer queue).

1. `prgenie watch stop` with no role (MCP `watch_stop` without `role` if listed). Do not stall looking for MCP.
2. Kill any `/loop` / monitored shell you started for `/queue` or `/inbox`. Await those shells so completion notices do not re-arm you.
3. Confirm: `prgenie watch inbox` and `prgenie watch queue` are both `halted reason=stop`. Do not `git push`. Do not `gh pr create`.
4. `/unwatch` does not auto-resume. `/start` / `create_local_pr` resume only an **export** halt after that id is archived or missing — never a stop halt.
5. If they also want the GitHub PR, they must run `/export`.
