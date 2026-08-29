---
name: review-inbox
description: One pass of the implementor inbox. Pull pending review comments on this branch's local PR and treat them as the brief. Use from the implementor chat or via /watch-review-inbox.
---

# Implementor inbox (one tick)

You are the **implementor** on this worktree. Do not review your own loop. Do not git push unless `/export-local-pr`.

0. Halt check — do not skip if MCP `watch_status` is missing. Prefer `node packages/cli/dist/prgenie.cjs watch`. `listening` continues. `halted` → kill the listen loop. Do not implement if halted.
1. Inbox: `node packages/cli/dist/prgenie.cjs inbox` (MCP `list_local_prs` `inbox=true` only if that parameter exists in the listing). That is only `changes_requested` loops with open findings. Prefer the loop whose `headRef` is the current branch. If the loop is still `ready`, the reviewer is still writing — wait. Do not address comments on `ready`.
2. If there are no `pendingComments`, say so in one line. If status is still `changes_requested` with everything **addressed** (legacy packet), `set_status` `ready`. Do not invent new work.
3. Skip ids you already submitted for a second review this session **unless** new open comments arrived.
4. `prgenie show <id>` / `get_local_pr` — `pendingComments` is the brief (each has `id` and `status=open`).
5. Fix on the current branch. Commit if needed **before** addressing so HEAD is current.
6. For each open comment: `address_comment` (or `prgenie address <id> <commentId> -m "..."`) with a reply of what you changed. That marks it `addressed` and nests the reply. **The last open finding automatically sets status to `ready` and posts Review requested** so the reviewer queue can pick it up. Do not `resolve_comment`. Do not only post a loose `role=agent` comment.
7. Confirm status is `ready` after the last address. If a legacy packet is still `changes_requested` with an empty inbox, `set_status` `ready` and `add_comment` `role=agent` **Review requested.**
