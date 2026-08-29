---
name: start-loop
description: Kick off implementor work from a ClickUp/Jira/Linear ticket or a chat brief. Use when the user runs /start-loop, pastes a ticket, or asks to start a loop with no local PR yet.
---

# Start a loop

Implementor. Do not self-review. Do not push.

Take the brief from the user message or from a ticket MCP (ClickUp `clickup_get_task`, Jira/Linear/GitHub if those tools exist). Ask once if neither is present.

`create_local_pr` with that title and body — this leaves `main` for a feature branch. Export halt resumes only if that export id is archived or missing. `/stop-watch` does not auto-resume. Implement, commit, refresh the summary, `ready` + **Review requested.**, then `/watch-review-inbox`.
