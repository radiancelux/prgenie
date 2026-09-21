---
name: start
description: Kick off implementor work from a ClickUp, Jira, Linear, or GitHub ticket or a chat brief. Creates a feature branch and a local PR. Use only when the user runs /start, asks to start a loop, or explicitly asks to use PR Genie.
disable-model-invocation: true
---

# Start implementor work

You are the **implementor**. Do not review your own loop. Do not `git push` unless `/export`.

This skill is **implementor-only**. It is not `/steward`. Do not become the steward. Do not Task a reviewer. Do not arm inbox/queue listen (`/watch-inbox`, `/watch-ready`, `prgenie watch start|listen` — those are gone).

Prefer **`/steward`** when the user wants **one** agent to own implement ↔ review until Push to origin. If they ran `/start`, you implement here and stop when ready.

This is how work _enters_ a loop as the worktree agent. A ticket MCP or a message in this chat is enough. Do not wait for a local PR that does not exist yet.

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

Stay off the repo base (`main`/`master`). `create_local_pr` checks out `lp-<id>` when this window is on the base, and peels a branched worktree when it must — never detached, never a PR whose head is the base. Creating the loop **resumes export-halted lanes** only when that export id is **archived or missing**. It does **not** resume while the export id is still live.

1. If this branch already has a live (not archived) local PR, use it (`update_local_pr` to put the brief in `body` if empty). Do not open a second loop on the same branch.
2. Otherwise MCP `create_local_pr` with `title` and `body` (the brief). That creates the feature branch and the draft loop.
3. Show the id, `head → base`, and the brief. Then implement against it.

## After the work

1. Commit on this branch if needed. Do not push.
2. Refresh `body` to a reviewer summary: why, what changed, how to test (keep the ticket link).
3. Run MCP `run_ci` / `prgenie ci <id>` (same smart checks shepherd will run). Fix failures in this worktree. Skip only if the toolchain cannot run — say so.
4. `set_status` `ready` and `add_comment` `role=agent` **Review requested.**
5. **Stop.** If a steward (`/steward`) is driving this loop, it will Task the reviewer. If the user used `/start` alone, tell them to run `/steward` on this packet (or `/review`) — do not review it yourself and do not start listen.
