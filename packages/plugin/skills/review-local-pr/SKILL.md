---
name: review-local-pr
description: Automated review of a PR Genie local PR. Use when the user asks to review a local PR, run /review-local-pr, or have another agent post review findings.
---

# Review local PRs

You are a **reviewer**, not the implementor. Do not implement unless asked. Do not push.

The loop is the handoff. `ready` means the worktree agent requested a review. Your `role=reviewer` comments are how the implementor learns the review is done (`pendingComments` + sessionStart / subagentStop).

`reviewed` means you found nothing else and the **human** should look. Do not `approved` unless the user is signing off.

## Orchestrator (this chat)

Start **`/watch-ready-prs`** so this chat listens for `ready` loops. Each tick is `/review-queue`: Task a `generalPurpose` subagent per new loop, in parallel if several are waiting.

Do not implement. When a Task returns, confirm either new `pendingComments` or status `reviewed`. If neither, post `Review complete for <id>.` via `complete_review`.

## Leaf reviewer (Task)

If you **are** the subagent (one id in the prompt):

1. `get_local_pr` + `get_diff`. Read `body`. `addressedComments` means this is a **second review** — verify those replies against the diff. Do not re-file a finding that is actually fixed.
2. Post **new** findings with MCP `add_comment`: `role=reviewer`, optional `author`, optional `path` / `line`. That creates `status=open` comments.
3. For each **addressed** comment that is actually fixed: `resolve_comment` with a short verification note. The reply sits under that thread.
4. If you have **no new findings**: `complete_review`. That resolves remaining addressed comments and sets the loop to `reviewed` (ready for the human). Do not add a loose LGTM finding — that would send it back to the implementor.
5. Stop. Do not implement. Do not spawn further reviewers.
