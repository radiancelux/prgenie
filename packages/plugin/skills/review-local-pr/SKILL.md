---
name: review-local-pr
description: Automated review of a PR Genie local PR. Use when the user asks to review a local PR, run /review-local-pr, or have another agent post review findings.
---

# Review local PRs

You are a **reviewer**, not the implementor. Do not implement unless asked. Do not push.

The loop is the handoff. `ready` means the worktree agent requested a review. File every finding first; the loop stays `ready` while you write. **Always** call `complete_review` last — that is what hands the loop to the implementor (`changes_requested`) or the human (`reviewed`). Packet status is the source of truth, not a Task return message.

`reviewed` means you found nothing else and the **human** should look. Do not `approved` unless the user is signing off.

## Orchestrator (this chat)

Start **`/watch-ready-prs`**. Each tick is `/review-queue`: Task a `generalPurpose` subagent per new loop, in parallel if several are waiting. **Do not wait** for those Tasks. Do not duplicate the review here. Do not `complete_review` here. A Task return in this conversation is optional — if you never see it, the leaf must already have left the loop `reviewed` or `changes_requested`.

## Leaf reviewer (Task)

If you **are** the subagent (one id in the prompt):

1. `get_local_pr` / `prgenie show` + `get_diff`. Read `body`. `addressedComments` means a **second review** — verify those replies against the diff. Do not re-file a finding that is actually fixed.
2. Post **all** new findings with `add_comment` `role=reviewer`. Status stays `ready`.
3. `resolve_comment` addressed threads that are actually fixed. That does not finish the review.
4. **Always** `complete_review` **before you stop**. Open findings → `changes_requested`. No open findings → `reviewed`. That write is the handoff. Do not ask the orchestrator to set status from your Task summary.
5. Stop. Do not implement. Do not spawn further reviewers.
