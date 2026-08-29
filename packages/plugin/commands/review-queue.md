---
name: review-queue
description: One pass of the reviewer queue. List ready local PRs and Task a reviewer subagent for each new loop. Use from the reviewer chat or via /watch-ready-prs.
---

# Reviewer queue (one tick)

You are the **reviewer orchestrator**. Do not implement. Do not push unless `/export-local-pr`.

0. Halt check — do not skip if MCP `watch_status` is missing from this chat's tool listing. Prefer `node packages/cli/dist/prgenie.cjs watch`. `listening` continues. `halted` → kill the listen loop (`reason=export` means a GitHub PR; `reason=stop` means they ended it). MCP `watch_status` is optional when that tool is actually listed. Do not dispatch Tasks if halted.
1. Ready queue: `node packages/cli/dist/prgenie.cjs queue`. MCP `list_local_prs` with `status=ready` only if that parameter exists in the listing (older MCP listings ignore it and return every loop).
2. Skip any `id`+`headSha` you already Tasked this session.
3. For each remaining loop, Task `generalPurpose` **in parallel** (one Task per loop). Prompt: review that id — `get_local_pr` / `prgenie show`, `get_diff` / `prgenie diff`, read `body`, post **all** findings first (`add_comment` `role=reviewer` or `prgenie comment <id> -m "..." --role reviewer`; status stays `ready`), `resolve_comment` addressed threads that are fixed, then **always** `complete_review` last (`prgenie complete-review <id>` if MCP `complete_review` is not listed). Open findings → `changes_requested`; none → `reviewed`. Do not implement or git push.
4. When a Task returns, `prgenie show <id>` (or `get_local_pr`) and confirm `changes_requested` or `reviewed`. If it is still `ready`, `complete_review` / `prgenie complete-review` yourself.
5. If the queue is empty, say so in one line. Do not invent work.
6. Remember dispatched `id`+`headSha` for the next tick.
