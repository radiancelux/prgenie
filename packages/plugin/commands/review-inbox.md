---
name: review-inbox
description: One pass of the implementor inbox. Pull pending review comments on this branch's local PR and treat them as the brief. Use from the implementor chat or via /watch-review-inbox.
---

# Implementor inbox (one tick)

You are the **implementor** on this worktree. Do not review your own loop. Do not git push unless `/export-local-pr`.

0. MCP `watch_status`. If `halted`: kill the listen loop. If `reason=export`, the developer opened GitHub — stop. If `reason=stop`, they ended the loop — stop. Do not implement.
1. MCP `list_local_prs` with `inbox=true` (or `prgenie inbox`). That is only `changes_requested` loops with open findings. Prefer the loop whose `headRef` is the current branch. If the loop is still `ready`, the reviewer is still writing — wait. Do not address comments on `ready`.
2. If there are no `pendingComments`, say so in one line. If status is still `changes_requested` and everything is **addressed** (not open), `set_status` `ready` and `add_comment` `role=agent` **Review requested.** Do not invent new work.
3. Skip ids you already submitted for a second review this session **unless** new open comments arrived.
4. `get_local_pr` — `pendingComments` is the brief (each has `id` and `status=open`).
5. Fix on the current branch. Commit if needed.
6. For each open comment: MCP `address_comment` with `commentId` and a reply of what you changed. That marks it `addressed` and nests the reply under the reviewer comment. Do not `resolve_comment`. Do not only post a loose `role=agent` comment.
7. When the inbox is empty: `set_status` `ready` and `add_comment` `role=agent` **Review requested.** so the reviewer listen loop can pick it up for a second review.
