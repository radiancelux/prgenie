---
name: review-inbox
description: One pass of the implementor inbox. Pulls pending review comments on this branch's local PR and treats them as the brief. Use from the implementor chat or via /watch-review-inbox ticks.
disable-model-invocation: true
---

# Implementor inbox (one tick)

You are the **implementor** on this worktree. Do not review your own loop. Do not git push unless `/export-local-pr`.

0. Halt check — do not skip if MCP `watch_status` is missing. Prefer `node packages/cli/dist/prgenie.cjs watch`. `listening` continues. `halted reason=stop` → kill the listen loop. Do not implement. `halted reason=export` → that packet shipped or export is in flight. Do **not** `prgenie watch start` unless the export id is **missing or archived** (`prgenie show <exportId>`). A different live loop on this checkout is not enough. `create_local_pr` resumes only when that id is archived or gone.
1. If this wake is `AGENT_LOOP_DONE_*` or the listen shell exited after the 60-tick cap, run `/stop-watch` and stop. Do not re-arm.
2. Inbox: `node packages/cli/dist/prgenie.cjs inbox`. That is **only this worktree's** loop (current branch / `worktreePath`), and only if it is `changes_requested` with open findings. Never implement another loop's packet. If this checkout's loop is still `ready`, the reviewer is still writing — wait. Do not address comments on `ready`.
3. If there are no `pendingComments`, say so in one line. If status is still `changes_requested` with everything **addressed** (legacy packet), `set_status` `ready`. Do not invent new work.
4. Skip ids you already submitted for a second review this session **unless** new open comments arrived.
5. `prgenie show <id>` / `get_local_pr` — `pendingComments` is the brief (each has `id` and `status=open`).
6. Fix on the current branch. Commit if needed **before** addressing so HEAD is current.
7. For each open comment: `address_comment` (or `prgenie address <id> <commentId> -m "..."`) with a reply of what you changed. That marks it `addressed` and nests the reply. **The last open finding automatically sets status to `ready` and posts Review requested** so the reviewer queue can pick it up. Do not `resolve_comment`. Do not only post a loose `role=agent` comment.
8. Confirm status is `ready` after the last address. If a legacy packet is still `changes_requested` with an empty inbox, `set_status` `ready` and `add_comment` `role=agent` **Review requested.**
