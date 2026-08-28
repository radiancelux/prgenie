---
name: review-inbox
description: One pass of the implementor inbox. Pull pending review comments on this branch's local PR and treat them as the brief. Use from the implementor chat or via /watch-review-inbox.
---

# Implementor inbox (one tick)

You are the **implementor** on this worktree. Do not review your own loop. Do not git push unless `/export-local-pr`.

0. MCP `watch_status`. If `halted`: kill the listen loop. If `reason=export`, the developer opened GitHub — stop. If `reason=stop`, they ended the loop — stop. Do not implement.
1. MCP `list_local_prs` with `inbox=true` (or `prgenie inbox`). Prefer the loop whose `headRef` is the current branch.
2. If there are no `pendingComments`, say so in one line. Do not invent work.
3. Skip ids you already finished addressing this session **unless** new comments arrived (newer than your last `role=agent` reply).
4. `get_local_pr` — `pendingComments` is the brief.
5. Fix on the current branch. Commit if needed.
6. `add_comment` `role=agent` summarizing what you did.
7. `set_status` `ready` and `add_comment` `role=agent` **Review requested.** so the reviewer listen loop can pick it up.
