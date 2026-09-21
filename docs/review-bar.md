# Default review bar

`/review` and steward-spawned reviewer Tasks use a **stack-agnostic process bar** shipped with the plugin:

[`packages/plugin/skills/review/process-bar.md`](../packages/plugin/skills/review/process-bar.md)

That bar covers HIGH/MEDIUM severity, required SYSTEM IMPACT and REGRESSIONS paragraphs, tests, a pointer to mechanical CI (`run_ci` / shepherd — see [ci-checks.md](ci-checks.md)), generic `package.json` supply-chain checks, and a `VERDICT` / SUMMARY output shape. It does **not** encode app or framework rules.

## Repo-specific guidance

Author stack / org standards in **`.prgenie/review.md`** at the repo root (paths, UI libs, always-fail categories, etc.). When that file is present, reviewers apply it **with** the process bar. When absent, the process bar alone is the bar.

Ingesting `.prgenie/review.md` into Task packets is tracked separately (RAD-102). Until then, the leaf reviewer reads the file from the worktree when it exists.

## Token hygiene

Steward Task prompts should **point** at `/review` + `process-bar.md` (and `.prgenie/review.md` when present). Do not paste the full bar or external review skills into every Task (RAD-88).
