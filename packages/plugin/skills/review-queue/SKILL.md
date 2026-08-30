---
name: review-queue
description: One pass of the reviewer queue. Lists ready local PRs and Tasks a reviewer subagent for each new loop. Use from the reviewer chat or via /watch-ready-prs ticks.
disable-model-invocation: true
---

# Reviewer queue (one tick)

You are the **reviewer orchestrator**. Do not implement. Do not push unless `/export-local-pr`.

0. Halt check — do not skip if MCP `watch_status` is missing. Prefer `node packages/cli/dist/prgenie.cjs watch queue` (the **queue** lane only). Combined `halted` is both lanes — do not treat an inbox-only stop as your halt. `listening` continues. `halted reason=stop` → kill this listen loop. `halted reason=export` → last packet shipped; do not dispatch. Do **not** `prgenie watch start` on this tick. A new `create_local_pr` resumes export-halted lanes after that id is archived or missing; it does not clear a stop halt.
1. If this wake is `AGENT_LOOP_DONE_*` or the listen shell exited after the 60-tick cap, run `/stop-review` and stop. Do not re-arm. Do not `/stop-watch`.
2. Ready queue: `node packages/cli/dist/prgenie.cjs queue`. Packet status is the source of truth — not a Task return message.
3. Skip any `id`+`headSha` you already Tasked this session. A still-`ready` loop you already dispatched is in progress — skip it; do not duplicate the review.
4. For each remaining loop, Task `generalPurpose` (one Task per loop; parallel if several). Prompt must include: one id only; `prgenie show` / `get_local_pr`, `prgenie diff` / `get_diff`, read `body`; if `reviewRequestedSha` is null (legacy packet), re-run `prgenie ready <id>` / `set_status ready` to arm it, or record the headSha being reviewed; post **all** findings first (`add_comment` `role=reviewer` or `prgenie comment --role reviewer`; status stays `ready`); `resolve_comment` addressed threads that are fixed; **`complete_review` before you stop** (`prgenie complete-review <id>` if MCP `complete_review` is not listed). Open findings → `changes_requested`; none → `reviewed`. That write **is** the handoff. Do not ask the parent to set status from your Task summary. Do not implement or git push.
5. **Do not wait for the Task.** Do not review that id in this chat. Do not `complete_review` here. A Task return in this conversation is optional — if you never see it, the leaf must already have left the loop `reviewed` or `changes_requested`. Keep the listen loop going until the 60-tick cap.
6. If the queue is empty, say so in one line. Do not invent work.
7. Remember dispatched `id`+`headSha` for the next tick.
