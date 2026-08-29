---
name: review-queue
description: One pass of the reviewer queue. List ready local PRs and Task a reviewer subagent for each new loop. Use from the reviewer chat or via /watch-ready-prs.
---

# Reviewer queue (one tick)

You are the **reviewer orchestrator**. Do not implement. Do not push unless `/export-local-pr`.

0. Halt check — do not skip if MCP `watch_status` is missing. Prefer `node packages/cli/dist/prgenie.cjs watch`. `listening` continues. `halted` → kill the listen loop. Do not dispatch Tasks if halted.
1. Ready queue: `node packages/cli/dist/prgenie.cjs queue`.
2. Skip any `id`+`headSha` you already Tasked this session.
3. For each remaining loop, Task `generalPurpose` (one Task per loop; parallel if several). Prompt: review that id — `prgenie show` / `get_local_pr`, `prgenie diff` / `get_diff`, read `body`, post **all** findings first (`add_comment` `role=reviewer` or `prgenie comment --role reviewer`; status stays `ready`), `resolve_comment` addressed threads that are fixed, then **always** `complete_review` last (`prgenie complete-review <id>` if MCP `complete_review` is not listed). Open findings → `changes_requested`; none → `reviewed`. Do not implement or git push.
4. **Do not wait for the Task.** Do not review that id in this chat. Do not `complete_review` here while a Task is outstanding — that races the leaf. Keep the listen loop going.
5. If a Task **returns later** in this conversation, then `prgenie show <id>` and confirm `changes_requested` or `reviewed`. Only `complete_review` yourself if that return is in-hand and the loop is still `ready`. On a later tick, a still-`ready` loop you already Tasked is in progress — skip it; do not duplicate the review.
6. If the queue is empty, say so in one line. Do not invent work.
7. Remember dispatched `id`+`headSha` for the next tick.
