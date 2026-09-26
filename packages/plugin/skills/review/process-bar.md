# Default review process bar

Stack-agnostic defaults for `/review` and reviewer Tasks. **Read this file; do not paste it or external Copilot / `review-open-prs` skills into Task prompts.**

When `.prgenie/review.md` exists in the repo under review, apply those stack / org rules **in addition** to this bar. When it is absent, this process bar alone is the bar. Do **not** invent app- or framework-specific rules in the plugin.

## Severity

- **HIGH** and **MEDIUM** only. Err toward MEDIUM when unsure.
- Skip style, naming, and trivia that ESLint / Prettier (or equivalent formatters) already own.

## Before findings (required)

Write these in the review chat (or a single agent comment) **before** filing `add_comment` findings:

1. **SYSTEM IMPACT** — one paragraph: who/what this change can affect. `local — no blast` is OK when true.
2. **REGRESSIONS / blast-radius** — check signature, schema, query-key, error, timing, default, and guard changes. Cite callers when relevant.

## Checks

| Area                          | What to do                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tests**                     | Non-trivial logic needs coverage. Flag weak asserts (always-true, snapshot-only with no behavior).                                                                                                                                            |
| **Mechanical CI**             | Confirm implementor/`run_ci` / shepherd/export gate expectations — do **not** reimplement CI. Point at `docs/ci-checks.md` and MCP `run_ci` / `prgenie ci` / shepherd. Missing green ready is a process note, not a re-run of the suite here. |
| **package.json supply-chain** | If `package.json` / lockfiles change: name the package(s); check against the repo’s known dependency set, peer ranges, and `engines`. Generic — not app-specific allowlists hardcoded in this plugin.                                         |

## Zero-tolerance (opt-in only)

Plugin defaults ship **empty** always-fail category keys. Fill them only from repo guidance (`.prgenie/review.md` or fallbacks — see `docs/repo-local-guidance.md`). Never hardcode stack always-fail lists here.

## Output shape

End the review (chat or summary comment) with:

```text
VERDICT: CLEAN | ISSUES_FOUND
SUMMARY: <1–3 sentences>
HIGH:
- <capped list; omit section if empty>
MEDIUM:
- <capped list; omit section if empty>
```

Cap lists (prefer ≤5 each). Each finding still gets a real `add_comment` `role=reviewer` thread for address/resolve.
