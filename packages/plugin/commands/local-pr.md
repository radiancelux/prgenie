---
name: local-pr
description: Create or update a PR Genie local pull request for the current branch. Use instead of git push or gh pr create.
---

# Create a local PR

Local pull requests for agent work. GitHub when you say so.

1. Confirm you are in a git checkout (main repo or a worktree). Do not create a new worktree.
2. Commit outstanding work on the current branch if the user wants it included.
3. Call MCP `create_local_pr` with `title` **and** `body`. `body` is the reviewer summary (why, what changed, how to test) — do not leave it empty.
4. Show the id, status (`draft`), head, base, and the summary.
5. Do not `git push` or `gh pr create`.

If a local PR already exists for this branch, show it with `list_local_prs` and update via `update_local_pr` (summary), `set_status`, or `add_comment` instead of opening GitHub. If it is `changes_requested`, read `pendingComments` first. Fill or refresh `body` before marking ready.
