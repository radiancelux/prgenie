---
name: local-pr
description: Create and update unpublished local pull requests with PR Genie. Use when agent work is ready for review, when the user mentions local PRs, or instead of pushing to GitHub.
---

# PR Genie local PRs

Do not push. Subagent output becomes a local PR on the developer's watch list.

When a coding subagent **commits** and stops, the `subagentStop` hook drafts a packet automatically. Explore/shell subagents with no file changes are ignored. If files changed but nothing was committed, the parent is told to commit — still no `git push`.

## Create

```
prgenie create --title "..." --base main
```

Or MCP `create_local_pr` with `title`, optional `body`, `base`, `head`.

## Inspect

- `prgenie list`
- `prgenie show <id>`
- `prgenie diff <id>`
- MCP `list_local_prs`, `get_local_pr`, `get_diff`

## Status

`draft` → `ready` → `approved` | `changes_requested`

Comments on a ready/approved packet move it to `changes_requested`.

## Worktrees

List with `prgenie worktrees` / MCP `list_worktrees`. Never create, apply, or delete worktrees unless the user asks. GitLens, Conductor, and Cursor own that.

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
