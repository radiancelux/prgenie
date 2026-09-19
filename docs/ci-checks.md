# Smart local CI

PR Genie selects local checks from the loop diff (implementor preflight **and** shepherd/export gate). Agents must not invent ad-hoc skips. Mapping lives in `packages/core/src/ci-select.ts`.

## Default suite

`format:check`, `lint`, `typecheck`, `test`, `build` (`pnpm <check>`). `check-versions` is not PR-blocking locally.

## Path mapping

Changed paths = committed `baseSha...headSha` plus dirty/untracked files in the CI cwd (loop worktree when it exists).

| Changed paths                                                                                             | Checks              | Why                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------- |
| Empty / unclassifiable (binaries, unknown extensions)                                                     | Full suite          | Uncertain — never silent skip                      |
| Config / CI (`package.json`, lockfiles, `tsconfig*`, eslint, prettier config, `.github/**`, `scripts/**`) | Full suite          | Broader blast radius                               |
| Docs / markdown only (`*.md`, `docs/**`, LICENSE, README, `*.txt`)                                        | `format:check` only | No unit tests / lint / build                       |
| Docs + style (`*.css`, `*.json` that is not config)                                                       | `format:check` only | Format, skip lint/test/build                       |
| `packages/cli/**`, `packages/core/**`, `packages/extension/**` source or tests                            | Full suite          | Code packages need lint + typecheck + test + build |

Uncertain mapping **always** runs the full configured suite.

## Speed

- **Fail-fast** (default): stop remaining checks after the first failure. Disable with `failFast: false` or `PRGENIE_CI_FAIL_FAST=0`.
- **Parallel** (default): independent checks run concurrently. Disable with `parallel: false` or `PRGENIE_CI_PARALLEL=0`.
- **Cache** (RAD-35): unchanged HEAD inputs reuse `.git/agent-console/ci-cache`.
- Progress UI shows **elapsed time per check**.

## Who runs what

| Actor                   | Command                                                 | When                                                 |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Implementor             | `prgenie ci <id>` / MCP `run_ci`                        | Before `set_status ready` / Review requested         |
| Implementor (CI-resume) | `prgenie ci <id> --failing lint,test`                   | After export-gate CI failure; return only when green |
| Steward / shepherd      | `prgenie shepherd` / `steward_next` / `shepherd_status` | After review clear; again after CI-resume            |
| Human export            | panel Push / `prgenie export`                           | Same gate; cancel is shared                          |

Skip implementor preflight only when the toolchain cannot run (say so). Do not skip a red check.

## Cancel (panel + chat)

Loop panel **Cancel** and MCP `abort_ci` / a cancelled `run_ci` · `shepherd_status` · `steward_next` share one abort token at `.git/agent-console/ci-abort/<id>.json`. That stops the in-flight suite in every process. Export-gate evaluations also take a per id+HEAD lock (`.git/agent-console/ci-lock/`) so steward and the panel do not run two full suites; a waiter adopts the persisted snapshot or aborts with the owner.

## UI

Panel + lane + agent-chat progress card list **which** checks were selected and **why**. Click a check name for status + RAD-74 excerpt/log. Elapsed time uses the same `formatElapsed` units as the CLI card.

## CI-resume (locked)

After a blocked export gate: steward `resume_implementor` → implementor fixes and re-runs failing checks → steward `evaluate_export_gate` **again**. Do **not** auto-spawn a reviewer because CI failed. Reviewer still owns product findings (`changes_requested`). Ready-for-human / Push language only on `handoff_human`.
