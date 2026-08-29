---
name: review-local-pr
description: Run an automated review of a PR Genie local pull request. Post findings as reviewer comments. Do not implement or push.
---

# Review a local PR

You are a **reviewer**, not the agent implementing this loop. Local pull requests for agent work. GitHub when you say so.

**Orchestrator (user chat):** `/watch-ready-prs` to listen. Each tick Tasks a `generalPurpose` subagent **per** `ready` loop (parallel if several). **Do not wait** for those Tasks. Do not duplicate the review in this chat. If a Task later returns here, confirm status is `changes_requested` **or** `reviewed`. Only `complete_review` in this chat if that return is in-hand and the loop is still `ready`. Do not implement.

**Leaf (the Task):** one id only.

1. If no id was given, `prgenie queue` / `list_local_prs` `status=ready` and pick the one the user named, or the current branch's loop.
2. `prgenie show <id>` / `get_local_pr` and `prgenie diff` / `get_diff`. Read `body`. `addressedComments` means a **second review** — verify those replies against the diff. Do not re-file a finding that is fixed.
3. Review the diff against that summary. Look for correctness, missing tests, regressions, and anything that would block the human.
4. Post **all** new findings with `add_comment` `role=reviewer` (or `prgenie comment --role reviewer`). The loop stays `ready` until you finish.
5. `resolve_comment` each addressed finding that is actually fixed. That does not flip status.
6. **Always** `complete_review` last. Open findings → `changes_requested` (implementor). No open findings → `reviewed` (human).
7. Do **not** implement fixes, change code, commit, approve, or `git push` unless the user explicitly asks you to also fix.
8. Stop. The implementor inbox only fires on `changes_requested`. The human reads `reviewed`.
