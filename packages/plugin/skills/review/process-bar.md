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

| Area                          | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tests**                     | Non-trivial logic needs coverage. Flag weak asserts (always-true, snapshot-only with no behavior). A new `packages/*/src/**/*.test.ts` must appear in root `pnpm test` / origin `build-test` (not only package-local runs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Reviewer CI backstop**      | Before `complete_review`, in the loop **`worktreePath`** at the reviewed **`headSha`**, run: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm exec prettier --check --end-of-line auto .` (Brett approved 2026-09-26). If `node_modules` is missing there, run `pnpm install --frozen-lockfile` once in that worktree first; a failure after install is a backstop failure. When the packet's `readyCi` is missing, its `headSha` differs from the reviewed `headSha`, its `outcome` is `skipped`, or its `checkSkips` is non-empty, also run the full suite: `node node_modules/tsx/dist/cli.mjs --test "packages/*/src/**/*.test.ts"` (same as `pnpm test`) (Brett approved 2026-09-26). Host repos with no root `package.json` script for `build`, `lint`, or `typecheck`: record that command as `not defined` in the output — do not file a finding for it. Any backstop command that exits non-zero or cannot start → **HIGH** `add_comment` `role=reviewer` naming the command and quoting the first failing lines. See `docs/ci-checks.md` for implementor `run_ci` / shepherd mapping. |
| **package.json supply-chain** | If `package.json` / lockfiles change: name the package(s); check against the repo’s known dependency set, peer ranges, and `engines`. Generic — not app-specific allowlists hardcoded in this plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Zero-tolerance (opt-in only)

Plugin defaults ship **empty** always-fail category keys. Fill them only from repo guidance (`.prgenie/review.md` or fallbacks — see `docs/repo-local-guidance.md`). Never hardcode stack always-fail lists here.

## Output shape

End the review (chat or summary comment) with:

```text
VERDICT: CLEAN | ISSUES_FOUND
SUMMARY: <1–3 sentences>
BACKSTOP:
- pnpm build: pass | fail | not defined
- pnpm lint: pass | fail | not defined
- pnpm typecheck: pass | fail | not defined
- pnpm exec prettier --check --end-of-line auto .: pass | fail | not defined
- node node_modules/tsx/dist/cli.mjs --test "packages/*/src/**/*.test.ts": pass | fail | not defined | (omit when full suite not required)
HIGH:
- <capped list; omit section if empty>
MEDIUM:
- <capped list; omit section if empty>
```

Cap lists (prefer ≤5 each). Each finding still gets a real `add_comment` `role=reviewer` thread for address/resolve.
