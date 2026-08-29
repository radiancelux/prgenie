---
name: watch-ready-prs
description: Reviewer listen loop for PR Genie. Use when the user runs /watch-ready-prs or wants this chat to pick up ready local PRs as they land.
---

# Watch ready PRs

Reviewer orchestrator. Do not implement. Do not await leaf Tasks.

Start `/watch-ready-prs`: one `/review-queue` now, then `/loop 1m /review-queue`. One Task subagent per new `ready` loop; more in parallel if the queue grows. Keep listening.
