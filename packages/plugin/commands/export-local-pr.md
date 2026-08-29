---
name: export-local-pr
description: Developer command. Halt listen loops and open a GitHub pull request at origin from a PR Genie local PR. Use only when the developer explicitly wants to publish.
---

# Export local PR to origin

The developer is cutting the GitHub PR. This is the explicit publish step.

1. MCP `watch_stop` is implied — `export_local_pr` also halts listen loops. Kill any `/loop` you started.
2. Resolve id: the one they named, else the current branch loop (`list_local_prs`).
3. Call MCP `export_local_pr` with that `id`. It approves the loop, `git push`es the branch to origin, and `gh pr create`s against the loop base. Repo must be bound (`gh_status` / `gh_use`) — ask which login if unbound. Do not guess.
4. Return the GitHub PR URL.
5. Do not keep reviewing or implementing on that loop unless they ask.

This command **is** permission to `git push` and `gh pr create` for that loop only.
