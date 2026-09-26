# Default review bar

Steward-spawned reviewer Tasks use **`prgenie-reviewer`** (strong tier; model in `packages/plugin/agents/prgenie-reviewer.md`).

`/review` and those reviewer Tasks use a **stack-agnostic process bar** shipped with the plugin:

[`packages/plugin/skills/review/process-bar.md`](../packages/plugin/skills/review/process-bar.md)

That bar covers HIGH/MEDIUM severity, required SYSTEM IMPACT and REGRESSIONS paragraphs, tests, a pointer to mechanical CI (`run_ci` / shepherd — see [ci-checks.md](ci-checks.md)), generic `package.json` supply-chain checks, and a `VERDICT` / SUMMARY output shape. It does **not** encode app or framework rules.

## Repo-specific guidance

Author stack / org standards in **`.prgenie/review.md`** at the repo root (paths, UI libs, always-fail categories, etc.). When that file is present, reviewers apply it **with** the process bar. When absent, fallbacks and the process bar alone apply — see [repo-local-guidance.md](repo-local-guidance.md).

PR Genie discovers guidance in this order:

1. `.prgenie/review.md`
2. `.cursor/rules/*review*`
3. `CLAUDE.md` → `## Review` section
4. Missing → process bar only (no error)

`steward_next` records a content hash on the loop packet and returns a **truncated excerpt** (`reviewerGuidanceBrief`) for reviewer Task prompts. Zero-tolerance and stack categories from `review.md` fill opt-in process-bar keys — not the reverse.

## Token hygiene

Steward Task prompts should **point** at `/review` + `process-bar.md` and paste the `reviewerGuidanceBrief` excerpt when present. Do not paste the full bar, full `review.md`, or external review skills into every Task (RAD-88).

## Implementor context

Repos may list CONTRIBUTING / standards / skill **paths** in `.prgenie/context.md`. `steward_next` returns `implementorContextBrief` so implementor Tasks **Read** the same sources before coding. See [repo-local-guidance.md](repo-local-guidance.md).
