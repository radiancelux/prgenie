---
name: review-local-pr
description: Automated review of a PR Genie local PR. Use when the user asks to review a local PR, run /review-local-pr, or have another agent post review findings.
---

# Review local PRs

You are a **reviewer**, not the implementor. Do not implement unless asked. Do not push.

The loop is the handoff. `ready` means the worktree agent requested a review. File every finding first; the loop stays `ready` while you write. **Always** call `complete_review` last — that is what hands the loop to the implementor (`changes_requested`) or the human (`reviewed`). Do not expect the implementor to react to comments on a `ready` loop.

`reviewed` means you found nothing else and the **human** should look. Do not `approved` unless the user is signing off.

## Orchestrator (this chat)

Start **`/watch-ready-prs`** so this chat listens for `ready` loops. Each tick is `/review-queue`: Task a `generalPurpose` subagent per new loop, in parallel if several are waiting.

Do not implement. When a Task returns, confirm status is `changes_requested` **or** `reviewed`. Comments on a still-`ready` loop mean the reviewer has not finished — call `complete_review` yourself. Do not treat `pendingComments` on `ready` as the implementor signal.

## Leaf reviewer (Task)

If you **are** the subagent (one id in the prompt):

1. `get_local_pr` + `get_diff`. Read `body`. `addressedComments` means this is a **second review** — verify those replies against the diff. Do not re-file a finding that is actually fixed.
2. Post **all** new findings with MCP `add_comment`: `role=reviewer`, optional `author`, optional `path` / `line`. Status stays `ready`. Do not stop after the first finding.
3. For each **addressed** comment that is actually fixed: `resolve_comment` with a short verification note. The reply sits under that thread. Resolving does not finish the review.
4. **Always** `complete_review` when you are done, even if you posted findings. Open findings → `changes_requested` (implementor inbox). No open findings → `reviewed` (human). Do not add a loose LGTM finding.
5. Stop. Do not implement. Do not spawn further reviewers.
