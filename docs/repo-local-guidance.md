# Authoring repo-local review guidance

Each repo can supply its own review rules. PR Genie discovers them at loop time, records a content hash on the loop packet, and injects a **truncated excerpt** (~1–2k tokens) into reviewer Task briefs. Implementors read the same sources of truth before coding.

## Discovery order

1. **`.prgenie/review.md`** (canonical)
2. **Fallbacks:** `.cursor/rules/*review*` (filename contains `review`, not all Cursor rules)
3. **`CLAUDE.md`** — `## Review` section only
4. **Missing** → generic [`process-bar.md`](../packages/plugin/skills/review/process-bar.md) only (no error)

Frontmatter `globs:` scoping is out of scope. Do not scrape all `.cursor/rules/*`.

## `.prgenie/review.md` template

Copy [`docs/examples/prgenie-review.md`](examples/prgenie-review.md) to your repo root as `.prgenie/review.md`.

Structure:

- **Org / always-apply rules** at the top (security, auth, data handling)
- **Stack / path-scoped rules** below (UI libs, framework patterns)
- **`## Zero-tolerance`** — always-fail categories (fill RAD-103 opt-in keys; plugin defaults stay empty)
- **`## Stack`** — stack-specific review categories

PR Genie reads the file, hashes it, and injects path + top bullet rules into the reviewer brief — not the full file.

## Shared implementor context

Add **`.prgenie/context.md`** (or extend it) to list paths the implementor must **Read** before coding:

```markdown
---
required: false
---

- CONTRIBUTING.md
- docs/architecture.md
- .cursor/skills/my-team/SKILL.md
```

- **Paths only** — never paste skill bodies into PR Genie plugin skills
- **`required: true`** in frontmatter → steward/implementor brief warns when no paths are listed
- **Missing file** → fail-soft unless `required: true`

See [`docs/examples/prgenie-context.md`](examples/prgenie-context.md).

## Steward / Task integration

`steward_next` returns:

- `reviewGuidance` — hash, source path, truncated excerpt
- `reviewerGuidanceBrief` — paste into reviewer Task prompt
- `repoContext` / `implementorContextBrief` — paths for implementor Task prompt

When guidance is absent, briefs omit repo sections and the process bar alone applies.

## Authoring from existing structure

| You already have…          | Map to…                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| Org security standards doc | Link or summarize top rules in `.prgenie/review.md` **Zero-tolerance** |
| `.cursor/rules/*review*`   | Optional fallback until you add `.prgenie/review.md`                   |
| `CLAUDE.md` review notes   | Optional fallback (`## Review` section)                                |
| `CONTRIBUTING.md`          | List path in `.prgenie/context.md`                                     |
| Team Cursor skills         | List skill **paths** in `.prgenie/context.md`                          |

Keep plugin skills generic; stack-specific rules live in the repo.
