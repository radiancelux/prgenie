---
name: watch-review-inbox
description: Implementor listen loop for PR Genie. Use when the user runs /watch-review-inbox or wants this chat to pick up reviewer comments as they land.
---

# Watch review inbox

Implementor on this worktree. Do not self-review.

Start `/watch-review-inbox`: one `/review-inbox` now, then `/loop 1m /review-inbox`. `pendingComments` is the brief. Resolve each with `resolve_comment`, then `ready` + `Review requested.`
