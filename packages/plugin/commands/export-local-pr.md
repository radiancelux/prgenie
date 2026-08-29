---
name: export-local-pr
description: Developer command. Halt listen loops and open a GitHub pull request at origin from a PR Genie local PR. Use only when the developer explicitly wants to publish.
---

# Export local PR to origin

The developer is cutting the GitHub PR. This is the explicit publish step.

1. MCP `watch_stop` is implied — `export_local_pr` also halts listen loops. Kill any `/loop` you started.
2. Resolve id: the one they named, else the current branch loop (`list_local_prs`).
3. Call MCP `export_local_pr` with that `id`, or use **Export to GitHub** on the loop panel when status is `reviewed` (or `ready` if you are signing off yourself). It `git push`es the loop SHA, `gh pr create`s against the loop base, marks the loop `approved` (archived, not deleted), checks the main workspace off the loop branch onto the loop base, and removes a sibling `../<repo>.loops/<id>` checkout. If this window is still on that extra worktree, reopen the primary folder so it can be cleared. Repo must be bound (`gh_status` / `gh_use`) — ask which login if unbound. Do not guess.
4. Return the GitHub PR URL. The loop remains on disk (`get_local_pr` / `prgenie show`); it drops off the default list.
5. Do not keep reviewing or implementing on that loop unless they ask.

This command **is** permission to `git push` and `gh pr create` for that loop only.
