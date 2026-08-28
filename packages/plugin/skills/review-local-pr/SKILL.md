---
name: review-local-pr
description: Automated review of a PR Genie local PR. Use when the user asks to review a local PR, run /review-local-pr, or have another agent post review findings.
---

# Review local PRs

You are reviewing someone else's packet. Do not implement unless asked. Do not push.

1. `list_local_prs` / `get_local_pr` / `get_diff` for the id (or current branch). Read `body` (author summary) before commenting on the diff.
2. `add_comment` with `role=reviewer` for findings. Optional `author` to label which agent reviewed.
3. Leave status as `changes_requested` (the comment does that). Do not `set_status approved`.
4. The implementing agent on that branch reads `pendingComments` next session (sessionStart injects them) and replies with `role=agent`.

If the user wants a second model, launch a Task with this same brief, then post that subagent's findings as `role=reviewer`.
