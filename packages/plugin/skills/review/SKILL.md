---
name: review
description: Automated review of a PR Genie local PR. Files reviewer findings, resolves fixed threads, and always complete_review. Use when the user asks to review a local PR, runs /review, or a reviewer Task is reviewing a ready loop.
---

# Review a local PR

You are a **reviewer**, not the implementor. Do not implement unless asked. Do not push.

The loop is the handoff. `ready` means the worktree agent requested a review. File every finding first; the loop stays `ready` while you write. **Always** call `complete_review` last — that is what hands the loop to the implementor (`changes_requested`) or marks **review cleared** (`reviewed`) so the steward can run the export gate. Packet status is the source of truth, not a Task return message.

`reviewed` means you found nothing else. It is **not** a human handoff and not Push to origin. Do not say “ready for human review.” The steward runs the export gate next. **Ready for human** / Push language only after `handoff_human` (gate green). Do not `approved` unless the user is signing off.

`/steward` owns one loop and **awaits** its reviewer Task. You are that leaf. Do not start listen. Do not spawn further reviewers.

## Process bar (defaults)

Apply the stack-agnostic bar in [process-bar.md](process-bar.md) (HIGH/MEDIUM, SYSTEM IMPACT, REGRESSIONS, tests, mechanical CI pointer, package.json supply-chain, `VERDICT` output). **Point at that file; do not paste it or external Copilot / `review-open-prs` skills into the Task.**

**Repo guidance:** if `.prgenie/review.md` is present, apply it with the process bar. If absent, use the process bar alone. Do not hardcode app or framework stack rules in plugin defaults. Authored guidance belongs in `.prgenie/review.md` (ingest: RAD-102 — not this skill).

## Leaf reviewer (Task)

If you **are** the subagent (one id in the prompt):

1. If no id was given, `prgenie queue` / `list_local_prs` `status=ready` and pick the one the user named, or the current branch's loop.
2. `get_local_pr` / `prgenie show` + `get_diff`. If `reviewRequestedSha` is null (legacy packet), re-run `set_status ready` / `prgenie ready <id>` to arm it, or record the `headSha` you are about to review and treat any later mismatch as drift. **Large loops:** call `get_diff` with `stat=true` (or `prgenie diff --stat`) first; if the full diff would truncate (~80KB on MCP), call `get_diff` again with `paths` for the files you need. Read `body`. Read [process-bar.md](process-bar.md); if the repo has `.prgenie/review.md`, read that too. `addressedComments` means a **second review** — verify those replies against the diff. Do not re-file a finding that is actually fixed.
3. Write **SYSTEM IMPACT** and **REGRESSIONS / blast-radius** (required by the process bar) **before** filing findings.
4. Post **all** new findings with `add_comment` `role=reviewer` (HIGH/MEDIUM only). Status stays `ready`. Long findings: MCP `add_comment` or `prgenie comment --body-file`. Do not pass finding text through an unquoted shell `-m`.
5. `resolve_comment` addressed threads that are actually fixed. That does not finish the review.
6. Before `complete_review`, compare `headSha` to `reviewRequestedSha` (`prgenie show` / `get_local_pr`). If they differ, HEAD moved after the review baseline — re-run `get_diff` and file any new findings **while status is still `ready`**. Do **not** call `complete_review` until the diff you reviewed matches HEAD (or you intentionally force). Ready handoffs (`set_status ready`, address last finding) now set `reviewRequestedSha` automatically.
7. Emit the process-bar **output shape** (`VERDICT` / `SUMMARY` / capped HIGH/MEDIUM). **Always** `complete_review` **before you stop** (`prgenie complete-review <id>` if MCP `complete_review` is not listed). Open findings → `changes_requested`. No open findings → `reviewed` (**review cleared**; steward runs the export gate — not a human handoff). Default complete copy must not say ready-for-human. If complete refuses with head drift, go back to step 6 — do not force unless the developer asked. That write is the review-clear handoff. Do not ask the orchestrator to set status from your Task summary.
8. Stop. Do not implement. Do not spawn further reviewers. Do not `git push`.
