# Smart local CI

PR Genie selects local checks from the loop diff (implementor preflight **and** shepherd/export gate). Agents must not invent ad-hoc skips. Mapping lives in `packages/core/src/ci-select.ts` (`selectCiChecks` → `{ checks[], reason[] }`).

## Default suite

`format:check`, `lint`, `typecheck`, `test`, `build` (`pnpm <check>`). Used only when mapping is **uncertain** or config-wide. `check-versions` is not PR-blocking locally.

## Path mapping (locked examples)

Changed paths = committed `baseSha...headSha` plus dirty/untracked files in the CI cwd (loop worktree when it exists).

`run_ci` / shepherd always run in the loop’s `worktreePath` when that checkout exists. A Cursor plugin-install cwd (`~/.cursor/plugins/...`) is refused or redirected — never a silent format fail against a stale linked build. Progress cards, CLI, and export-gate snapshots cite `CI cwd: <path>`.

### Worktree deps (RAD-92)

Loop checkouts under `../<repo>.loops/<id>` usually have **no** `node_modules`. Before checks run, PR Genie **junctions** (Windows) or **symlinks** (macOS/Linux) `node_modules` from the primary checkout into the worktree so `pnpm exec eslint|tsc|tsx|prettier` resolve. Package-local `packages/*/node_modules` are linked the same way when present on primary.

| Situation | Behavior |
| --------- | -------- |
| Primary has `node_modules` | Auto-junction/link into the loop worktree (preferred) |
| Junction/link impossible | Fall back to `pnpm install` **in the worktree** only then |
| Primary also missing deps | Clear **CI environment unhealthy** setup error with fix steps — not an opaque red lint/test failure |
| Product lint/test fail | Hard-blocks export (shepherd `reasons` / gate `blocked`) |
| Env unhealthy only | Soft-surfaced (`ciEnvUnhealthy`); does **not** hard-block export by default |

Fix path when setup fails: `pnpm install` once in the **primary** checkout, then re-run `prgenie ci` / shepherd (junction recreates). Manual worktree install: `cd ../<repo>.loops/<id> && pnpm install`. See [troubleshooting.md](troubleshooting.md#worktree-ci-toolchain-windows).

| Changed paths                                                                                             | Checks                                                     | `reason[]` (concept)                                |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| Empty / unclassifiable (binaries, unknown extensions)                                                     | Full suite                                                 | `uncertain path mapping` / `uncertain → full suite` |
| Config / CI (`package.json`, lockfiles, `tsconfig*`, eslint, prettier config, `.github/**`, `scripts/**`) | Full suite                                                 | `config/CI scripts changed; running full suite`     |
| Docs / markdown only (`*.md`, `*.mdc`, `docs/**`, LICENSE, README, `*.txt`)                               | `format:check` only                                        | `docs/markdown-only → format:check`; skip units     |
| Docs + style (`*.css`, non-config `*.json`)                                                               | `format:check` only                                        | format; skip lint/test/build                        |
| `packages/core/**` source/tests (+ optional docs)                                                         | `format:check`, `lint:core`, `typecheck:core`, `test:core` | confident — **not** full monorepo `pnpm test`       |
| `packages/cli/**` / `packages/extension/**` (same pattern)                                                | `format:check` + `lint\|typecheck\|test:<pkg>`             | per-package unit + typecheck/lint                   |
| Multiple scopable packages                                                                                | format + each package’s lint→typecheck→test in order       | fail-fast stops after first package suite fail      |
| Bundled `packages/plugin/hooks\|mcp/*.cjs` + scopable core/cli/extension                                  | Same as the scopable package row(s)                        | build artifacts ignored for scoping                 |
| Other `packages/plugin/**` code, or only those `.cjs` with no scopable package                            | Full suite                                                 | `uncertain → full suite`                            |

Bundled MCP/hooks `.cjs` outputs (`isPluginBuildArtifact`) are skipped when collecting package scopes so a rebuild beside `packages/core|cli|extension` does not force full suite. Alone, or with other unscoping plugin paths, mapping stays uncertain → full suite.

**Confident mapping forbids whole-repo `pnpm test`.** Agents must run MCP `run_ci` / `prgenie ci` (or the scoped commands it prints) and must **print** the returned `{ checks, reason }` plan. Do not substitute a manual full-suite `pnpm test` when `packageScoped` / reasons say the mapping is confident.

Uncertain mapping **always** runs the full configured suite and includes an explicit `uncertain → full` reason.

## Speed

- **Fail-fast** (default): stop remaining checks after the first failure. Disable with `failFast: false` or `PRGENIE_CI_FAIL_FAST=0`.
- **Package suites**: implementor preflight runs package-scoped checks **sequentially** so fail-fast **stops after the first package suite fail** (do not continue lint/typecheck/test for later packages).
- **Parallel** (default for full suite): independent root checks may run concurrently. Disable with `parallel: false` or `PRGENIE_CI_PARALLEL=0`.
- **Cache** (RAD-35): unchanged HEAD inputs reuse `.git/agent-console/ci-cache`.
- Progress UI shows **elapsed time per check**.

## Who runs what

| Actor                   | Command                                                 | When                                                 |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Implementor             | `prgenie ci <id>` / MCP `run_ci`                        | Before `set_status ready` / Review requested         |
| Implementor (CI-resume) | `prgenie ci <id> --failing lint,test`                   | After export-gate CI failure; return only when green |
| Steward / shepherd      | `prgenie shepherd` / `steward_next` / `shepherd_status` | After review clear; again after CI-resume            |
| Human export            | panel Push / `prgenie export`                           | Same gate; cancel is shared                          |

Skip implementor preflight only when the toolchain cannot run (say so). Do not skip a red check. Do not “just `pnpm test` the whole repo” when `run_ci` already selected a confident scoped plan.

When a human/steward **skips** CI: MCP `abort_ci` returns the bound `implementorTaskId` — stop/interrupt that Task in the same steward turn (abort alone leaves the implementor looping).

## Generated MCP bundle size

Large line-count swings on `packages/plugin/mcp/server.cjs` (and hooks `.cjs`) after a rebuild are expected when dependencies are externalized or re-inlined — not a product source deletion. Prefer reading the TypeScript under `packages/core` / `packages/cli` for behavior.

## Cancel (panel + chat)

Loop panel **Cancel** and MCP `abort_ci` / a cancelled `run_ci` · `shepherd_status` · `steward_next` share one abort token at `.git/agent-console/ci-abort/<id>.json`. That stops the in-flight suite in every process. Export-gate evaluations also take a per id+HEAD lock (`.git/agent-console/ci-lock/`) so steward and the panel do not run two full suites; a waiter adopts the persisted snapshot or aborts with the owner.

## UI

Panel + lane + agent-chat progress card list **which** checks were selected and **why** (`reason[]`). Click a check name for status + RAD-74 excerpt/log. Elapsed time uses the same `formatElapsed` units as the CLI card.

## CI-resume (locked)

After a blocked export gate: steward `resume_implementor` → implementor fixes and re-runs failing checks → steward `evaluate_export_gate` **again**. Do **not** auto-spawn a reviewer because CI failed. Reviewer still owns product findings (`changes_requested`). Ready-for-human / Push language only on `handoff_human`.
