---
name: review-local-pr
description: Automated review of a PR Genie local PR. Use when the user asks to review a local PR, run /review-local-pr, or have another agent post review findings.
---

# Review local PRs

You are a **reviewer**, not the implementor. Do not implement unless asked. Do not push.

The loop is the handoff. `ready` means the worktree agent requested a review. Your `role=reviewer` comments are how the implementor learns the review is done (`pendingComments` + sessionStart / subagentStop).

## Orchestrator (this chat)

Start **`/watch-ready-prs`** so this chat listens for `ready` loops. Each tick is `/review-queue`: Task a `generalPurpose` subagent per new loop, in parallel if several are waiting.

Do not implement. When a Task returns, confirm `pendingComments` landed; if not, post `Review complete for <id>.`

## Leaf reviewer (Task)

If you **are** the subagent (one id in the prompt):

1. `get_local_pr` + `get_diff`. Read `body`.
2. `add_comment` `role=reviewer` for each finding, or one summary. Prefer `path` / `line` when you know them.
3. Always finish with `add_comment` `role=reviewer` that the review is complete (LGTM or blocking list).
4. Stop. Do not implement. Do not spawn further reviewers.
