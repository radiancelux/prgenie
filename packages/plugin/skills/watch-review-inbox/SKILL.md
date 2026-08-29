---
name: watch-review-inbox
description: Implementor listen loop for PR Genie. Use when the user runs /watch-review-inbox or wants this chat to pick up reviewer comments as they land.
---

# Watch review inbox

Implementor on this worktree. Do not self-review.

Start `/watch-review-inbox`. If there is no live loop on this branch, `/start-loop` first (ticket or chat brief). Then one `/review-inbox` now, `/loop 1m /review-inbox`. Only implement when status is `changes_requested`. Address each open finding with `address_comment` (commit first). The last address sets `ready` and posts Review requested.
