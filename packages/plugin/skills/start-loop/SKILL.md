---
name: start-loop
description: Kick off implementor work from a ClickUp, Jira, Linear, or GitHub ticket or a chat brief. Creates a feature branch and a local PR. Use when the user runs /start-loop, pastes a ticket, or asks to start a loop with no local PR yet.
---

# Start a loop

You are the **implementor**. Do not review your own loop. Do not `git push` unless `/export-local-pr`.

This is how work *enters* the flywheel. A ticket MCP or a message in this chat is enough. Do not wait for a local PR that does not exist yet.

## Brief

Take the work from, in order:

1. **This message** — a ticket URL/id, or a plain-language brief the user typed.
2. **An attached MCP** — if they named ClickUp, Jira, Linear, GitHub Issues, etc., discover that namespace (`GetDynamicTools`) and fetch the issue. For ClickUp, `clickup_get_task` with `include: ["description"]` (task id from `/t/<id>` or a custom id like `DEV-1234`). Chat-thread URLs ending in `/t/<id>` are messages, not tasks.
3. **Ask once** — if there is still no brief, ask for a ticket link or a short description. Then stop until they reply.

Do not invent a task. Do not start coding with an empty brief.

Write the brief down as:

- **Title** — ticket title, or one line from the user
- **Body** — ticket description plus acceptance notes; include the ticket URL/id when you have one

## Branch and packet

Stay off the repo base (`main`/`master`). `create_local_pr` checks out `lp-<id>` when this window is on the base, and peels a branched worktree when it must — never detached, never a PR whose head is the base. Creating the loop **resumes** listen loops only if halt is **export** and that export id is **archived or missing**. It does **not** resume after `/stop-watch`, `/stop-loop`, or `/stop-review`, and it does **not** resume while the export id is still live.

1. If this branch already has a live (not archived) local PR, use it (`update_local_pr` to put the brief in `body` if empty). Do not open a second loop on the same branch. If `prgenie watch` is `halted reason=export`, `prgenie watch start` only when the export id is missing or archived. Do not start just because this live loop's id differs from the export id.
2. Otherwise MCP `create_local_pr` with `title` and `body` (the brief). That creates the feature branch and the draft loop. Export halt clears only if the exported id is archived or gone.
3. Show the id, `head → base`, and the brief. Then implement against it.

## After the work

1. Commit on this branch if needed. Do not push.
2. Refresh `body` to a reviewer summary: why, what changed, how to test (keep the ticket link).
3. `set_status` `ready` and `add_comment` `role=agent` **Review requested.**
4. Start **`/watch-review-inbox`** in this chat if it is not already listening. That listen **stops itself after 60 ticks** (~1 hour at 1m). Re-run `/watch-review-inbox` to continue. The reviewer chat should be on **`/watch-ready-prs`**. It Tasks reviewers and must not await them.
