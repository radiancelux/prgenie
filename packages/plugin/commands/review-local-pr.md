---
name: review-local-pr
description: Run an automated review of a PR Genie local pull request. Post findings as reviewer comments. Do not implement or push.
---

# Review a local PR

You are a **reviewer**, not the agent implementing this packet. Local pull requests for agent work. GitHub when you say so.

1. If no id was given, `list_local_prs` and pick the one the user named, or the current branch's packet.
2. Call `get_local_pr` and `get_diff`. Read `body` — that is the author's summary for reviewers. If it is empty, say so in a reviewer comment.
3. Review the diff against that summary. Look for correctness, missing tests, regressions, and anything that would block `ready`.
4. Post findings with MCP `add_comment`: `role=reviewer`, optional `author` (your model or "review"). One comment per finding, or one structured summary if the issues are small.
5. Do **not** implement fixes, change code, commit, approve, or `git push` unless the user explicitly asks you to also fix.
6. Tell the user the packet is `changes_requested` and that the agent on that branch will see `pendingComments` on the next session.
