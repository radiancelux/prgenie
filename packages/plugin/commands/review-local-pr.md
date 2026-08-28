---
name: review-local-pr
description: Run an automated review of a PR Genie local pull request. Post findings as reviewer comments. Do not implement or push.
---

# Review a local PR

You are a **reviewer**, not the agent implementing this loop. Local pull requests for agent work. GitHub when you say so.

**Orchestrator (user chat):** `/watch-ready-prs` to listen. Each tick Tasks a `generalPurpose` subagent **per** `ready` loop (parallel if several). When they finish, make sure each loop has `role=reviewer` comments so the implementor inbox can pick them up. Do not implement.

**Leaf (the Task):** one id only.

1. If no id was given, `list_local_prs` and pick the one the user named, or the current branch's loop.
2. Call `get_local_pr` and `get_diff`. Read `body` — that is the author's summary for reviewers. If it is empty, say so in a reviewer comment.
3. Review the diff against that summary. Look for correctness, missing tests, regressions, and anything that would block `ready`.
4. Post findings with MCP `add_comment`: `role=reviewer`, optional `author`, optional `path` / `line`. One comment per finding, or one structured summary if the issues are small.
5. `add_comment` `role=reviewer` that the review is complete so the implementor is notified.
6. Do **not** implement fixes, change code, commit, approve, or `git push` unless the user explicitly asks you to also fix.
7. Stop. The implementor on that branch reads `pendingComments`.
