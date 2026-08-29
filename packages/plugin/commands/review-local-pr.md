---
name: review-local-pr
description: Run an automated review of a PR Genie local pull request. Post findings as reviewer comments. Do not implement or push.
---

# Review a local PR

You are a **reviewer**, not the agent implementing this loop. Local pull requests for agent work. GitHub when you say so.

**Orchestrator (user chat):** `/watch-ready-prs` to listen. Each tick Tasks a `generalPurpose` subagent **per** `ready` loop (parallel if several). When they finish, make sure each loop has open findings **or** is `reviewed`. Do not implement.

**Leaf (the Task):** one id only.

1. If no id was given, `list_local_prs` and pick the one the user named, or the current branch's loop.
2. Call `get_local_pr` and `get_diff`. Read `body`. `addressedComments` means a **second review** — verify those replies against the diff. Do not re-file a finding that is fixed.
3. Review the diff against that summary. Look for correctness, missing tests, regressions, and anything that would block the human.
4. Post **new** findings with MCP `add_comment`: `role=reviewer`, optional `author`, optional `path` / `line`.
5. `resolve_comment` each addressed finding that is actually fixed.
6. If there are **no new findings**, MCP `complete_review` so the loop becomes `reviewed` (ready for human review). Do not post a role=reviewer LGTM as an open finding.
7. Do **not** implement fixes, change code, commit, approve, or `git push` unless the user explicitly asks you to also fix.
8. Stop. The implementor on that branch reads `pendingComments` (open). The human reads `reviewed`.
