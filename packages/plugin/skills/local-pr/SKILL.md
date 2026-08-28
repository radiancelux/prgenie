---
name: local-pr
description: Create and update unpublished local pull requests with PR Genie. Use when agent work is ready for review, when the user mentions local PRs, or instead of pushing to GitHub.
---

# PR Genie local PRs

Do not push. Subagent output becomes a local PR on the developer's watch list.

When a coding subagent **commits** and stops, the `subagentStop` hook drafts a packet automatically. Explore/shell subagents with no file changes are ignored. If files changed but nothing was committed, the parent is told to commit — still no `git push`.

## Create

```
prgenie create --title "..." --body "## Summary\n- ...\n\n## Test\n- ..." --base main
```

Or MCP `create_local_pr` with `title` and **`body`**. `body` is the packet summary for reviewers — not optional when you are the implementing agent.

Write it like a GitHub PR description:

- Why this exists
- What changed (bullets)
- How to test

If the packet already exists, `update_local_pr` with `body` (or `prgenie update <id> --body "..."`). Fill the summary before `set_status ready`.

## Inspect

- `prgenie list`
- `prgenie show <id>`
- `prgenie diff <id>`
- MCP `list_local_prs`, `get_local_pr`, `get_diff`

## Status

`draft` → `ready` → `approved` | `changes_requested`

Comments are the review protocol for the agent on that packet:

| role | Who | Effect |
| --- | --- | --- |
| `human` | You (GUI, CLI, chat) | Status → `changes_requested`. Injected into the next session on that branch. |
| `reviewer` | Automated review agent | Same as human. Findings only — that agent does not implement unless asked. |
| `agent` | The implementer on this PR | Reply / done note. Does not change status. Then `set_status ready`. |

`pendingComments` on `get_local_pr` are human/reviewer notes since the last agent reply.

## Address comments

If the current branch's local PR is `changes_requested`:

1. `get_local_pr` and read `pendingComments`.
2. Fix on the current branch. Commit if needed.
3. `add_comment` with `role=agent` summarizing what changed.
4. `set_status` `ready`.
5. Do not `git push`.

## Automated review

Use `/review-local-pr` or MCP as a **reviewer**, not the implementer:

1. `get_local_pr` + `get_diff`.
2. `add_comment` with `role=reviewer` (and optional `author`) for each finding or one summary.
3. Do not implement, approve, or push unless the user asks.

You may launch a Task subagent with that brief if the user wants a second-pass review. Post its findings with `role=reviewer`. The implementing agent (this branch / next session) picks them up.

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
