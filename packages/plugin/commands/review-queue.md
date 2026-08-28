---
name: review-queue
description: One pass of the reviewer queue. List ready local PRs and Task a reviewer subagent for each new loop. Use from the reviewer chat or via /watch-ready-prs.
---

# Reviewer queue (one tick)

You are the **reviewer orchestrator**. Do not implement. Do not push unless `/export-local-pr`.

0. MCP `watch_status`. If `halted`: kill the listen loop. If `reason=export`, the developer cut a GitHub PR — stop. If `reason=stop`, they ended the loop — stop. Do not dispatch Tasks.
1. MCP `list_local_prs` with `status=ready` (or `prgenie queue`).
2. Skip any `id`+`headSha` you already Tasked this session.
3. For each remaining loop, Task `generalPurpose` **in parallel** (one Task per loop). Prompt: review that id — `get_local_pr`, `get_diff`, read `body`, `add_comment` `role=reviewer` for findings or LGTM, then `add_comment` `role=reviewer` that the review is complete. Do not implement or git push.
4. If the queue is empty, say so in one line. Do not invent work.
5. Remember dispatched `id`+`headSha` for the next tick.
