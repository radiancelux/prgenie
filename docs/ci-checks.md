# Smart local CI

PR Genie selects local checks from the loop diff (implementor preflight **and** shepherd/export gate). Agents must not invent ad-hoc skips. Mapping lives in `packages/core/src/ci-select.ts` (`selectCiChecks` → `{ checks[], reason[] }`). Host-repo command rewriting (path args / turbo filters) lives in `packages/core/src/ci-host-scope.ts`.

## Default suite

`format:check`, `lint`, `typecheck`, `test`, `build` (`pnpm <check>`). Used only when mapping is **uncertain** or config-wide. `check-versions` is not PR-blocking locally.

## Two scoping modes

| Mode                                  | When                                                                                                                                               | What runs                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR Genie package-scoped** (RAD-105) | Changed paths stay under `packages/core\|cli\|extension`                                                                                           | Check names like `lint:core` → `pnpm exec eslint packages/core/src` (never root `pnpm test`)                                                                |
| **Host-repo path-scoped** (RAD-120)   | Root checks selected on a host monorepo (Phoenix-style) whose `package.json` scripts are monorepo-wide (`eslint .`, `turbo run lint`, `pnpm -r …`) | Same root check names (`lint`, …) but **execution** rewrites to changed-path args or `--filter` — progress shows `eslint path1 path2`, not bare `pnpm lint` |

RAD-105 package scoping is unchanged. Host-repo scoping does **not** invent `lint:core` on foreign repos; it keeps root check names and scopes the **command**.

### Host-repo fail-closed

Keep the full `pnpm <check>` script (with an explicit reason) when:

- Config / CI / toolchain files changed (`package.json`, eslint config, lockfiles, …)
- Paths are empty or unclassifiable
- The script is not a known monorepo-wide pattern (or is already path-scoped, like prgenie’s root `eslint packages/…`)
- Turbo / `pnpm -r` cannot map paths to `packages|apps|services/<name>/`

## Path mapping (locked examples)

Changed paths = committed `baseSha...headSha` plus dirty/untracked files in the CI cwd (loop worktree when it exists).

`run_ci` / shepherd always run in the loop’s `worktreePath` when that checkout exists. A Cursor plugin-install cwd (`~/.cursor/plugins/...`) is refused or redirected — never a silent format fail against a stale linked build. Progress cards, CLI, and export-gate snapshots cite `CI cwd: <path>`.

### Worktree deps (RAD-92)

Loop checkouts under `../<repo>.loops/<id>` usually have **no** `node_modules`. Before checks run, PR Genie **junctions** (Windows) or **symlinks** (macOS/Linux) `node_modules` from the primary checkout into the worktree so `pnpm exec eslint|tsc|tsx|prettier` resolve. Package-local `packages/*/node_modules` are linked the same way when present on primary.

| Situation                  | Behavior                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Primary has `node_modules` | Auto-junction/link into the loop worktree (preferred)                                               |
| Junction/link impossible   | Fall back to `pnpm install` **in the worktree** only then                                           |
| Primary also missing deps  | Clear **CI environment unhealthy** setup error with fix steps — not an opaque red lint/test failure |
| Product lint/test fail     | Hard-blocks export (shepherd `reasons` / gate `blocked`)                                            |
| Env unhealthy only         | Soft-surfaced (`ciEnvUnhealthy`); does **not** hard-block export by default                         |

Fix path when setup fails: `pnpm install` once in the **primary** checkout, then re-run `prgenie ci` / shepherd (junction recreates). Manual worktree install: `cd ../<repo>.loops/<id> && pnpm install`. See [troubleshooting.md](troubleshooting.md#worktree-ci-toolchain-windows).

| Changed paths                                                                                             | Checks                                                        | `reason[]` (concept)                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Empty / unclassifiable (binaries, unknown extensions)                                                     | Full suite                                                    | `uncertain path mapping` / `uncertain → full suite`  |
| Config / CI (`package.json`, lockfiles, `tsconfig*`, eslint, prettier config, `.github/**`, `scripts/**`) | Full suite                                                    | `config/CI scripts changed; running full suite`      |
| Docs / markdown only (`*.md`, `*.mdc`, `docs/**`, LICENSE, README, `*.txt`)                               | `format:check` only (changed prettier paths)                  | `docs/markdown-only → format:check`; skip units      |
| Docs + style (`*.css`, non-config `*.json`)                                                               | `format:check` only (changed prettier paths)                  | format; skip lint/test/build                         |
| `packages/core/**` source/tests (+ optional docs)                                                         | `format:check` (changed paths) + `lint\|typecheck\|test:core` | confident — **not** full monorepo `pnpm test`        |
| `packages/cli/**` / `packages/extension/**` (same pattern)                                                | `format:check` + `lint\|typecheck\|test:<pkg>`                | per-package unit + typecheck/lint                    |
| Multiple scopable packages                                                                                | format + each package’s lint→typecheck→test in order          | fail-fast stops after first package suite fail       |
| Bundled `packages/plugin/hooks\|mcp/*.cjs` + scopable core/cli/extension                                  | Same as the scopable package row(s)                           | build artifacts ignored for scoping                  |
| Other `packages/plugin/**` code, or only those `.cjs` with no scopable package                            | Full suite                                                    | `uncertain → full suite`                             |
| Host repo paths outside prgenie SCOPABLE_PACKAGES (e.g. `apps/mobile/**`) + root `lint: "eslint ."`       | Full suite **names**; lint **exec** → `eslint <changed>`      | host-repo path scope (RAD-120); config → full script |

Bundled MCP/hooks `.cjs` outputs (`isPluginBuildArtifact`) are skipped when collecting package scopes so a rebuild beside `packages/core|cli|extension` does not force full suite. Alone, or with other unscoping plugin paths, mapping stays uncertain → full suite.

**Confident mapping forbids whole-repo `pnpm test`.** Agents must run MCP `run_ci` / `prgenie ci` (or the scoped commands it prints) and must **print** the returned `{ checks, reason }` plan. Do not substitute a manual full-suite `pnpm test` when `packageScoped` / reasons say the mapping is confident.

On host repos, when progress shows `eslint path1 path2` (or turbo `--filter`), do **not** replace that with root `pnpm lint` / `eslint .`.

Uncertain mapping **always** runs the full configured suite **names** and includes an explicit `uncertain → full` reason. Host-repo execution may still path-scope root scripts when paths are known source/test and not config.

## Speed

- **Fail-fast** (default): stop remaining checks after the first failure. Disable with `failFast: false` or `PRGENIE_CI_FAIL_FAST=0`.
- **Package suites**: implementor preflight runs package-scoped checks **sequentially** so fail-fast **stops after the first package suite fail** (do not continue lint/typecheck/test for later packages).
- **Parallel** (default for full suite): independent root checks may run concurrently. Disable with `parallel: false` or `PRGENIE_CI_PARALLEL=0`.
- **format:check scope** (RAD-117): confident package-scoped or docs/style-only plans blob-check **only changed prettier-able paths** (loop diff + dirty/untracked in the CI cwd). Uncertain / config / full suite still format the **full tracked prettier tree** (origin cleanliness bar). Always git blob content (LF) — never working-tree CRLF (RAD-46). Progress shows `format:check (blobs) <paths>` when scoped, or `pnpm format:check` for the full tree. Host `prettier --check .` rewrite stays deferred (blob runner owns format).
- **Host-repo vs package**: RAD-105 rewrites check **names** (`lint:core`). RAD-120 rewrites host **commands** (`eslint <changed>`). Format scoping is independent: it filters the blob file list from `changedPaths`, not a prettier CLI rewrite.
- **Cache** (RAD-35): unchanged HEAD inputs reuse `.git/agent-console/ci-cache`.
- Progress UI shows **elapsed time per check** and the **actual command** (including path args / blob scope).

## Who runs what

| Actor                   | Command                                                 | When                                                 |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Implementor             | `prgenie ci <id>` / MCP `run_ci`                        | Before `set_status ready` / Review requested         |
| Implementor (CI-resume) | `prgenie ci <id> --failing lint,test`                   | After export-gate CI failure; return only when green |
| Steward / shepherd      | `prgenie shepherd` / `steward_next` / `shepherd_status` | After review clear; again after CI-resume            |
| Human export            | panel Push / `prgenie export`                           | Same gate; cancel is shared                          |

Skip implementor preflight only when the toolchain cannot run (say so) or a human/steward gives an **explicit skip reason** (RAD-97). Do not skip a red check. Do not “just `pnpm test` the whole repo” when `run_ci` already selected a confident scoped plan.

When a human/steward **skips** CI: MCP `abort_ci` returns the bound `implementorTaskId` — stop/interrupt that Task in the same steward turn (abort alone leaves the implementor looping).

## Generated MCP bundle size

`packages/plugin/mcp/server.cjs` and `packages/plugin/hooks/*.cjs` are **generated and gitignored**. CI / `pnpm build` / `pnpm link-plugin` produce them; a no-op rebuild must not create a multi-thousand-line git diff.

If you still see huge ±tens-of-thousands-line diffs on those paths in a PR, you have a dirty local build against an old **tracked** file, or you are on a **pre-migration** branch from before they were removed from the index. Prefer reading TypeScript under `packages/core` / `packages/cli` for behavior; rebuild or rebase onto current `main`.

## Cancel (panel + chat)

Loop panel **Cancel** and MCP `abort_ci` / a cancelled `run_ci` · `shepherd_status` · `steward_next` share one abort token at `.git/agent-console/ci-abort/<id>.json`. That stops the in-flight suite in every process. Export-gate evaluations also take a per id+HEAD lock (`.git/agent-console/ci-lock/`) so steward and the panel do not run two full suites; a waiter adopts the persisted snapshot or aborts with the owner.

## UI

Panel + lane + agent-chat progress card list **which** checks were selected and **why** (`reason[]`). Click a check name for status + RAD-74 excerpt/log. Elapsed time uses the same `formatElapsed` units as the CLI card. The command line must match what ran (`eslint apps/foo.ts`, not only `lint`).

## CI-resume (locked)

After a blocked export gate: steward `resume_implementor` → implementor fixes and re-runs failing checks → steward `evaluate_export_gate` **again**. Do **not** auto-spawn a reviewer because CI failed. Reviewer still owns product findings (`changes_requested`). Ready-for-human / Push language only on `handoff_human`.
