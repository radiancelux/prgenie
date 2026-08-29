---
name: review-local-pr
description: Automated review of a PR Genie local PR. Files reviewer findings, resolves fixed threads, and always complete_review. Use when the user asks to review a local PR, runs /review-local-pr, or a reviewer Task is reviewing a ready loop.
---

# Review a local PR

You are a **reviewer**, not the implementor. Do not implement unless asked. Do not push.

The loop is the handoff. `ready` means the worktree agent requested a review. File every finding first; the loop stays `ready` while you write. **Always** call `complete_review` last — that is what hands the loop to the implementor (`changes_requested`) or the human (`reviewed`). Packet status is the source of truth, not a Task return message.

`reviewed` means you found nothing else and the **human** should look. Do not `approved` unless the user is signing off.

## Orchestrator (this chat)

`/watch-ready-prs` listens (60-tick cap). Each tick is `/review-queue`: Task a `generalPurpose` subagent per new loop, in parallel if several are waiting. **Do not wait** for those Tasks. Do not duplicate the review here. Do not `complete_review` here. `/stop-review` or `/stop-watch` ends listen.

## Leaf reviewer (Task)

If you **are** the subagent (one id in the prompt):

1. If no id was given, `prgenie queue` / `list_local_prs` `status=ready` and pick the one the user named, or the current branch's loop.
2. `get_local_pr` / `prgenie show` + `get_diff`. **Large loops:** call `get_diff` with `stat=true` (or `prgenie diff --stat`) first; if the full diff would truncate (~80KB on MCP), call `get_diff` again with `paths` for the files you need. Read `body`. `addressedComments` means a **second review** — verify those replies against the diff. Do not re-file a finding that is actually fixed.
3. Post **all** new findings with `add_comment` `role=reviewer`. Status stays `ready`. Long findings: MCP `add_comment` (Content-Length framed) or `prgenie comment --body-file`. Do not pass finding text through an unquoted shell `-m`.
4. `resolve_comment` addressed threads that are actually fixed. That does not finish the review.
5. Before `complete_review`, compare `headSha` to `reviewRequestedSha` (`prgenie show` / `get_local_pr`). If they differ, HEAD moved after Review requested — re-run `get_diff` and file any new findings **while status is still `ready`**. Do **not** call `complete_review` until the diff you reviewed matches HEAD (or you intentionally force).
6. **Always** `complete_review` **before you stop** (`prgenie complete-review <id>` if MCP `complete_review` is not listed). Open findings → `changes_requested`. No open findings → `reviewed`. If complete refuses with head drift, go back to step 5 — do not force unless the developer asked. That write is the handoff. Do not ask the orchestrator to set status from your Task summary.
7. Stop. Do not implement. Do not spawn further reviewers. Do not `git push`.
