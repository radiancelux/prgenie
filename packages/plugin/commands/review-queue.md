---
name: review-queue
description: One pass of the reviewer queue. List ready local PRs and Task a reviewer subagent for each new loop. Use from the reviewer chat or via /watch-ready-prs.
---

# Reviewer queue (one tick)

You are the **reviewer orchestrator**. Do not implement. Do not push unless `/export-local-pr`.

0. MCP `watch_status`. If `halted`: kill the listen loop. If `reason=export`, the developer cut a GitHub PR — stop. If `reason=stop`, they ended the loop — stop. Do not dispatch Tasks.
1. MCP `list_local_prs` with `status=ready` (or `prgenie queue`).
2. Skip any `id`+`headSha` you already Tasked this session.
3. For each remaining loop, Task `generalPurpose` **in parallel** (one Task per loop). Prompt: review that id — `get_local_pr`, `get_diff`, read `body`, post **all** `add_comment` `role=reviewer` findings first (status stays `ready`), `resolve_comment` addressed threads that are fixed, then **always** `complete_review` last (open findings → `changes_requested`; none → `reviewed`). Do not implement or git push.
4. When a Task returns, `get_local_pr` and confirm `changes_requested` or `reviewed`. If it is still `ready`, call `complete_review` yourself.
5. If the queue is empty, say so in one line. Do not invent work.
6. Remember dispatched `id`+`headSha` for the next tick.
