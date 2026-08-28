---
name: local-pr
description: Create and update unpublished local pull requests with PR Genie. Use when agent work is ready for review, when the user mentions local PRs, or instead of pushing to GitHub.
---

# PR Genie local PRs

Do not push. Subagent output becomes a local PR on the developer's watch list.

When a coding subagent **commits** and stops, the `subagentStop` hook drafts a loop automatically. Explore/shell subagents with no file changes are ignored. If files changed but nothing was committed, the parent is told to commit — still no `git push`.

## Create

```
prgenie create --title "..." --body "## Summary\n- ...\n\n## Test\n- ..." --base main
```

Or MCP `create_local_pr` with `title` and **`body`**. `body` is the loop summary for reviewers — not optional when you are the implementing agent.

Write it like a GitHub PR description:

- Why this exists
- What changed (bullets)
- How to test

If the loop already exists, `update_local_pr` with `body` (or `prgenie update <id> --body "..."`). Fill the summary before `set_status ready`.

## Inspect

- `prgenie list`
- `prgenie show <id>`
- `prgenie diff <id>`
- MCP `list_local_prs`, `get_local_pr`, `get_diff`

## Status

`draft` → `ready` → `approved` | `changes_requested`

Comments are the review protocol for the agent on that loop:

| role | Who | Effect |
| --- | --- | --- |
| `human` | You (GUI, CLI, chat) | Status → `changes_requested` (including from **draft** — that is intended). Injected into the next session on that branch. |
| `reviewer` | Automated review agent | Same as human. Findings only — that agent does not implement unless asked. |
| `agent` | The implementer on this PR | Reply. Use `resolve_comment` to close a finding. Does not change status. Then `set_status ready` for a second review. |

`pendingComments` on `get_local_pr` are **unresolved** human/reviewer notes. Resolved threads stay on the loop so the reviewer can verify them.

## Address comments

If the current branch's local PR is `changes_requested`:

1. `get_local_pr` and read `pendingComments` (unresolved human/reviewer notes; each has an `id`).
2. Fix on the current branch. Commit if needed.
3. For **each** pending comment, MCP `resolve_comment` with that `commentId` and a reply (what you changed). Status stays `changes_requested`.
4. When the inbox is done: `set_status` `ready` and `add_comment` `role=agent` **Review requested.** That is the second review for the reviewer chat.
5. Do not `git push`. Do not review your own loop.

## Requesting review

You are the agent **on the worktree** (implementor). On completion:

1. Loop exists, `body` is a real summary, HEAD matches the work.
2. `set_status` `ready`.
3. `add_comment` `role=agent`: `Review requested.`
4. Stop. Start **`/watch-review-inbox`** in this chat if it is not already listening. The **reviewer chat** should be on **`/watch-ready-prs`**. It Tasks subagents — one per `ready` loop.
5. When review is done, the loop has `role=reviewer` comments. `/review-inbox` (or the watch loop) treats `pendingComments` as the brief. Do not wait for a DM; the loop is the channel.

If there is **no** reviewer chat, Task one reviewer subagent yourself for this id only.

`/stop-watch` ends listen loops without publishing. `/export-local-pr` is the developer cutting the GitHub PR at origin.

## Worktrees

Each loop has a git worktree. If the branch is already checked out (this window), that checkout is the loop. Otherwise PR Genie adds `../<repo>.loops/<id>`. Use **Switch** in Local PRs / the loop panel to replace this window with that worktree. `prgenie worktree <id>` / MCP `ensure_worktree` only creates the checkout — they do not open the editor.

Do not delete worktrees unless the user asks. Do not create extras beyond the one per loop.

## GitHub accounts

Bind is **per repository**, stored in `.git/agent-console/github.json` (not committed). `gh` still has only one active login globally; the bind is how this repo keeps the right one.

**Who sets it**

- The user can run `prgenie gh use <login>` once in that repo.
- Or they name the account in chat ("use radiancelux for this project"). Then the agent calls MCP `gh_use` with that login.
- If the repo is unbound and GitHub work is needed, the agent lists accounts with `gh_list` / `prgenie gh list` and **asks which login** — it does not guess.

After a bind exists, do not `gh auth switch`. The hook switches to the bound account before `gh` / `git push`.

```
prgenie gh list
prgenie gh use <login>
```

## Export

Only if the user explicitly asks to publish. That is not the default, and V1 of the plugin does not auto-export.
