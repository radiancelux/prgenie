# Smart local CI

PR Genie selects local checks from the loop diff (implementor preflight **and** shepherd/export gate). Agents must not invent ad-hoc skips. Mapping lives in `packages/core/src/ci-select.ts` (`selectCiChecks` → `{ checks[], reason[] }`). Host-repo command rewriting (path args / turbo filters) lives in `packages/core/src/ci-host-scope.ts`.

## Default suite

`format:check`, `lint`, `typecheck`, `test`, `build` (`pnpm <check>`) exist as **legacy / host caller names** (`DEFAULT_CI_CHECKS`). **Local `run_ci` / shepherd must never select this full set** (RAD-119). Confident package-scoped or docs/style plans only. If mapping cannot be confident: **skip with an explicit printable reason** (empty `checks[]`, `skipped: true`) — origin CI remains the cleanliness bar. Agents may manually run only touched-package tests; they must **not** substitute root `pnpm test`.

## Two scoping modes

| Mode                                  | When                                                                                                                                               | What runs                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR Genie package-scoped** (RAD-105) | Changed paths stay under `packages/core\|cli\|extension`                                                                                           | Check names like `lint:core` → `pnpm exec eslint packages/core/src` (never root `pnpm test`)                                                                |
| **Host-repo path-scoped** (RAD-120)   | Root checks selected on a host monorepo (Phoenix-style) whose `package.json` scripts are monorepo-wide (`eslint .`, `turbo run lint`, `pnpm -r …`) | Same root check names (`lint`, …) but **execution** rewrites to changed-path args or `--filter` — progress shows `eslint path1 path2`, not bare `pnpm lint` |

RAD-105 package scoping is unchanged. Host-repo scoping does **not** invent `lint:core` on foreign repos; it keeps root check names and scopes the **command**.

### Host-repo fail-closed

Keep the **full `pnpm <check>` script body** for a _single_ root check name (with an explicit reason) when host-scoping that check:

- Config / CI / toolchain files changed (`package.json`, eslint config, lockfiles, …)
- Paths are empty or unclassifiable
- The script is not a known monorepo-wide pattern (or is already path-scoped, like prgenie’s root `eslint packages/…`)
- Turbo / `pnpm -r` cannot map paths to `packages|apps|services/<name>/`

That is **not** permission to select the entire `DEFAULT_CI_CHECKS` list (including root `test`) from `selectCiChecks`. Unmappable product loops **skip** locally (RAD-119).

## Path mapping (locked examples)

Changed paths = committed `baseSha...headSha` plus dirty/untracked files in the CI cwd (loop worktree when it exists).

`run_ci` / shepherd always run in the loop’s `worktreePath` when that checkout exists. A Cursor plugin-install cwd (`~/.cursor/plugins/...`) is refused or redirected — never a silent format fail against a stale linked build. Progress cards, CLI, and export-gate snapshots cite `CI cwd: <path>`.

### Worktree CI selection (RAD-123)

RAD-112 fixed **cwd**. Selection still used to come from the **in-memory / installed plugin** `selectCiChecks`, so a loop that edits `ci-select` / `ci-runner` could not be gated by its own code until merge + relink.

`run_ci`, shepherd, and the export gate now call `resolveCiSelection`:

1. When the loop worktree has `packages/core/src/ci-select.ts`, **always** evaluate `selectCiChecks` from that **worktree source** (via `tsx` `tsImport`, with a CLI fallback) — not the in-memory install. Persist `ciCwd` = the loop worktree and keep `worktreePath` on the packet.
2. Compare `{ checks, reason, skipped, uncertain, packageScoped }` to the installed plugin. On divergence: **warn loudly** on stderr and **use the worktree plan** (refuse the stale installed plan). Classic stale reasons like `core source/test changed — format, lint, typecheck, test, build` / root `test`+`build` are treated as a full-suite plan and **refused** if the worktree module cannot load.
3. If the worktree module is missing/unloadable and the installed plan looks like that full suite → **throw** (do not silently run root `pnpm test`).
4. **Peer / stored-gate replay:** a ready/blocked snapshot for the same HEAD that still carries that stale full-suite `ciPlan` is **not adoptable**. `evaluateAndStoreExportGate` invalidates it and re-runs with worktree selection; `needsExportGateEvaluation` stays true until a non-stale plan is stored. Shepherd/`run_ci` also refuse to execute a resolved stale plan (except explicit test fixtures that pass `selection`).

A loop that only changes CI selection (or any product loop with a worktree) must not select root `pnpm test` via a stale plugin **or** via replaying a peer’s old gate. After changing selection code, **rebuild + `pnpm link-plugin` from the loop worktree** so the Cursor MCP (`~/.cursor/plugins/local/prgenie/mcp/server.cjs`) actually runs `resolveCiSelection`.

Printable `{ checks, reason }` from the gate must match what unit tests of the worktree selector print for the same paths.

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

| Changed paths                                                                                           | Checks                                                        | `reason[]` (concept)                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Empty after name-status + base…HEAD + dirty tree                                                        | **Skip** (empty plan)                                         | `no changed paths` / `skip local CI` — never `uncertain → full`    |
| Unclassifiable (binaries, unknown extensions)                                                           | **Skip**                                                      | `uncertain path mapping` / `skip local CI`                         |
| Hard config / CI (`package.json` root, lockfiles, `tsconfig*` root, eslint, `.github/**`, `scripts/**`) | **Skip**                                                      | `config/CI scripts changed; cannot confidently scope`              |
| Docs / markdown only (`*.md`, `*.mdc`, `docs/**`, LICENSE, README, `*.txt`)                             | `format:check` only (changed prettier paths)                  | `docs/markdown-only → format:check`; skip units                    |
| Docs + style (`*.css`, non-config `*.json`, incidental plugin meta)                                     | `format:check` only (changed prettier paths)                  | format; skip lint/test/build                                       |
| `packages/core/**` source/tests (+ optional docs / incidental plugin meta)                              | `format:check` (changed paths) + `lint\|typecheck\|test:core` | confident — **not** full monorepo `pnpm test`                      |
| Leaf core module + sibling test (e.g. `progress.ts`) — **not** shared surface (RAD-127)                 | Same checks; `test:core` runs **only** covering `*.test.ts`   | reason + progress list file paths; command is not the package glob |
| Core shared surface (`git`/`prs`/`steward`/`export-gate`/`ci-runner`/…) or package config (RAD-127)     | Same checks; `test:core` keeps `packages/core/src/*.test.ts`  | reason says shared surface / config → package glob                 |
| `packages/cli/**` / `packages/extension/**` (same pattern)                                              | `format:check` + `lint\|typecheck\|test:<pkg>`                | per-package unit + typecheck/lint                                  |
| Package-local `packages/{core\|cli\|extension}/package.json` (or tsconfig)                              | Same as that package’s scoped row                             | package-local config → scope, not hard-config skip                 |
| Multiple scopable packages                                                                              | format + each package’s lint→typecheck→test in order          | fail-fast stops after first package suite fail                     |
| Bundled `packages/plugin/hooks\|mcp/*.cjs` + scopable core/cli/extension                                | Same as the scopable package row(s)                           | build artifacts ignored for scoping                                |
| Bundled plugin `.cjs` alone                                                                             | **Skip**                                                      | `plugin build artifacts only`                                      |
| Routine `packages/plugin/**` source (skills, hooks `.mjs`, rules) without core/cli/extension            | Thin plugin suite: `format:check` only                        | `packages/plugin/** → thin plugin suite`                           |
| Incidental `plugin.json` / `mcp.json` / `hooks.json` under `packages/plugin/**` + scoped package        | Same as the scopable package row(s)                           | meta is not `config → full suite`                                  |
| Host repo paths outside prgenie SCOPABLE_PACKAGES (e.g. `apps/mobile/**`)                               | **Skip** locally (RAD-119); origin CI is the bar              | printable skip — agent may run touched-package tests               |
| Host repo + caller-provided single root check (RAD-120)                                                 | That check’s **exec** may path-scope (`eslint <changed>`)     | host-repo path scope; config → full **script** for that check      |

### Audited dogfood cases (RAD-119) — former `uncertain → full suite` / `config → full suite`

| Dogfood trigger                                                            | Old outcome              | New outcome                                     |
| -------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| Empty / incomplete path discovery mid-loop                                 | `uncertain → full suite` | Prefer name-status + `base…HEAD`; else **skip** |
| Only generated `packages/plugin/hooks\|mcp/*.cjs`                          | full suite               | **skip** (`plugin build artifacts only`)        |
| Plugin skills / hooks `.mjs` / rules without core/cli/extension            | full suite               | thin plugin `format:check`                      |
| `plugin.json` / `mcp.json` / `hooks.json` beside a core/cli/extension edit | `config → full suite`    | ignore meta; keep package-scoped plan           |
| Root `package.json` / `.github` / eslint config on a product loop          | `config → full suite`    | **skip** (origin is the bar)                    |
| `packages/core/package.json` (+ core source)                               | full suite               | scoped `*:core`                                 |

Bundled MCP/hooks `.cjs` outputs (`isPluginBuildArtifact`) are skipped when collecting package scopes so a rebuild beside `packages/core|cli|extension` does not force a skip or thin suite by itself. Alone, mapping skips with an explicit reason.

**Confident mapping forbids whole-repo `pnpm test`.** Agents must run MCP `run_ci` / `prgenie ci` (or the scoped commands it prints) and must **print** the returned `{ checks, reason }` plan. Do not substitute a manual full-suite `pnpm test` when `packageScoped` / reasons say the mapping is confident. When `skipped: true` / `checks: []`, do **not** invoke full suite — skip with that reason or manually run only touched-package tests.

On host repos, when progress shows `eslint path1 path2` (or turbo `--filter`), do **not** replace that with root `pnpm lint` / `eslint .`.

Uncertain / hard-config mapping **skips** local CI with an explicit `skip local CI` / `never full monorepo pnpm test` reason (RAD-119). Host-repo execution may still path-scope a **caller-selected** single root script when paths are known source/test and not config.

## Speed

- **Git fixture templates** (RAD-133): heavy core suites (`export-gate`, `shepherd`, `ci-runner` loop-CI, `ci-abort`) clone a process-local seeded template (`packages/core/src/test-git-fixture.ts`) instead of `git init` per test. Templates are removed on process exit (best effort). Measured Windows solo `export-gate.test.ts` (2026-09-25): `main` @ `d9f5674` mean **104.8s**; RAD-133 branch mean **113.2s** (**103.2s** uncontended). The ~522s dogfood baseline did not reproduce solo — wall time is dominated by six tests that run real CI checks. AC5 speed target moved to **RAD-146**.
- **Fail-fast** (default): stop remaining checks after the first failure. Disable with `failFast: false` or `PRGENIE_CI_FAIL_FAST=0`.
- **Package suites**: implementor preflight runs package-scoped checks **sequentially** so fail-fast **stops after the first package suite fail** (do not continue lint/typecheck/test for later packages).
- **Parallel** (default when multiple independent root checks are caller-selected): independent checks may run concurrently. Disable with `parallel: false` or `PRGENIE_CI_PARALLEL=0`. Package-scoped plans are always sequential.
- **format:check scope** (RAD-117): confident package-scoped or docs/style-only plans blob-check **only changed prettier-able paths** (loop diff + dirty/untracked in the CI cwd). Skip plans run no format. Always git blob content (LF) — never working-tree CRLF (RAD-46). Progress shows `format:check (blobs) <paths>` when scoped, or `pnpm format:check` when a caller still requests full-tree format. Host `prettier --check .` rewrite stays deferred (blob runner owns format).
- **test:core file scope** (RAD-127): leaf core modules (and sibling `*.test.ts`) that do **not** touch the shared git-fixture / steward / export-gate / ci-runner surface select only those covering test files. Progress shows `tsx --test packages/core/src/progress.test.ts` (and `1/N files` when multiple). Shared-surface or package-config diffs keep `packages/core/src/*.test.ts` with an explicit reason. `--failing test:core` re-selects from the same paths, so the file list repeats.
- **Host-repo vs package**: RAD-105 rewrites check **names** (`lint:core`). RAD-120 rewrites host **commands** (`eslint <changed>`). Format scoping is independent: it filters the blob file list from `changedPaths`, not a prettier CLI rewrite.
- **Cache** (RAD-35, RAD-118): per-check input hashes cover **worktree** content in that check’s scope, not only committed HEAD. Unrelated dirty edits **outside** the set below stay cached. Anything uncertain (unreadable path, non-regular entry, unknown ignored directory) is a **miss** — never a false pass. A real hit still shows progress `cached` with **0 elapsed**. Stored under `.git/agent-console/ci-cache`.

  **Included**

  - Tracked, dirty, and untracked files under the check scope: `packages/<pkg>/**` for `lint|typecheck|test|build:<pkg>`. `typecheck:*`, `test:*`, and `build:*` also include each `workspace:*` dependency package. File-scoped `test:*` uses that **same** tree (the selected test paths change only the command string, not the file set).
  - Other gitignored files in that scope (a new ignored file is a miss).
  - On **every** check, worktree bytes of root `package.json`, `pnpm-lock.yaml`, and `tsconfig.base.json` when that file exists (unstaged edits count).
  - `lint:*`: root ESLint config files that exist. `typecheck:*`: root `tsconfig.json` when it exists. `build:*`: `scripts/build.mjs` when it exists.
  - `format:check`: changed prettier-able paths as **index blobs** (LF, matching the blob runner), plus Prettier config and `.prettierignore` as worktree bytes. The three root inputs above are still worktree bytes.
  - The check command (`ciCheckCommand`, including a file-scoped `test:*` argv) and the target package’s `package.json` text.
  - `test:*` also includes `HEAD^{tree}`, so a moved base misses even when the selected test file list is unchanged.

  **Left out** (a hit stays valid)

  - Gitignored install/build/tool trees: `node_modules/**`, `dist/**`, `coverage/**`, `.turbo/**`, `.vscode-test/**`, and `*.vsix`. Untracked listings use `git ls-files -o --directory` plus omit pathspecs so those trees are **never descended** — including a primary→worktree `node_modules` junction when the worktree has no `.gitignore`. Post-filtering after a full `-o` walk is not enough (that walk is the hang). Dependency identity is the hashed lockfile and root `package.json`, not the install tree.
  - Files outside the scope above (a dirty root `README.md` does not invalidate `lint:core`).
  - `format:check` does not hash worktree CRLF for source files; those use the index blob.

  **Always a miss**

  - A symlink, junction, or other non-regular entry whose path is itself in scope (tracked or untracked), including a tracked directory symlink.
  - A gitignored directory in scope that is not one of the omitted trees above.
  - An untracked directory in scope that is not one of the omitted trees (listed as a directory line; contents are not walked).
  - Unreadable inputs, or `test:*` when `HEAD^{tree}` cannot be resolved.
  - A check that passed while its inputs changed mid-run (hash before; re-hash after; record only if unchanged).

- **Per-check timeout** (RAD-133): format/lint/typecheck/build default to **20 minutes**; `test` / `test:*` (including full `packages/core/src/*.test.ts` globs on Windows) default to **40 minutes** so ~28 min suites finish inside `run_ci` / `prgenie ci`. MCP `mcp.json` / `MCP_SERVER_TIMEOUT_SEC` matches the **40-minute** package-test wall so `run_ci` and `shepherd_status` are not cut off at 20 minutes (RAD-100).
- Progress UI shows **elapsed time per check** and the **actual command** (including path args / blob scope).

## Who runs what

| Actor                   | Command                                                 | When                                                 |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Implementor             | `prgenie ci <id>` / MCP `run_ci`                        | Before `set_status ready` / Review requested         |
| Implementor (CI-resume) | `prgenie ci <id> --failing lint,test`                   | After export-gate CI failure; return only when green |
| Steward / shepherd      | `prgenie shepherd` / `steward_next` / `shepherd_status` | After review clear; again after CI-resume            |
| Human export            | panel Push / `prgenie export`                           | Same gate; cancel is shared                          |

Skip implementor preflight only when the toolchain cannot run (say so), mapping **skips** with a printable reason (RAD-119), or a human/steward gives an **explicit skip reason** (RAD-97). Do not skip a red scoped check. Do not “just `pnpm test` the whole repo” when `run_ci` already selected a confident scoped plan — and never escalate a skip/uncertain plan into full suite.

When a human/steward **skips** CI (or hits panel **Cancel**): MCP `abort_ci` / panel Cancel both call `abortCiForSteward` and return the bound `implementorTaskId` — stop/interrupt that Task in the same steward turn. Cancel is the skip half; the panel alone does not kill the agent (abort alone leaves the implementor looping).

## Generated MCP bundle size

`packages/plugin/mcp/server.cjs` and `packages/plugin/hooks/*.cjs` are **generated and gitignored**. CI / `pnpm build` / `pnpm link-plugin` produce them; a no-op rebuild must not create a multi-thousand-line git diff.

If you still see huge ±tens-of-thousands-line diffs on those paths in a PR, you have a dirty local build against an old **tracked** file, or you are on a **pre-migration** branch from before they were removed from the index. Prefer reading TypeScript under `packages/core` / `packages/cli` for behavior; rebuild or rebase onto current `main`.

## Cancel (panel + chat)

Loop panel **Cancel** and MCP `abort_ci` share one path: `abortCiForSteward` bumps the abort token at `.git/agent-console/ci-abort/<id>.json` (stops in-flight `run_ci` · `shepherd_status` · `steward_next` in every process) and returns `{ stewardAction, implementorTaskId }`.

- **Bound implementor:** `stewardAction` is `stop_implementor_and_abort_ci`. Cancel is the **skip half** — abort CI and surface the Task id. Do **not** assume the panel alone kills the agent; the steward (or human) must still stop/interrupt that Task so it does not keep calling `run_ci`.
- **No implementor bound:** `stewardAction` is `abort_ci_only` — abort token only.

Export-gate evaluations also take a per id+HEAD lock (`.git/agent-console/ci-lock/`) so steward and the panel do not run two full suites; a waiter adopts the persisted snapshot or aborts with the owner.

### Process tree kill (RAD-135)

Each CI shell check runs via `execCiShell` (`packages/core/src/ci-kill.ts`). Timeout and Cancel both **kill the spawned child and its descendants** so `tsx --test` / node workers cannot outlive the parent (especially on Windows).

| Platform    | Mechanism                                                        |
| ----------- | ---------------------------------------------------------------- |
| **Windows** | `taskkill /PID <shell-pid> /T /F` on the cmd.exe/pnpm shell      |
| **POSIX**   | `detached: true` spawn + `SIGKILL` on the process group (`-pid`) |

Progress and failure excerpts distinguish outcomes:

| Outcome            | Progress / excerpt                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------ |
| **Timeout**        | `<check> timed out after <N>s` (optional TAP tail); check state `fail`                     |
| **Cancel**         | `<check> cancelled`; in-flight check reports `skip` with that message, then the run aborts |
| **maxBuffer**      | `<check> output exceeded max buffer`                                                       |
| **Real test fail** | First `not ok` / assertion (unchanged)                                                     |

Implementors: when Cancel fires mid-check, do not assume orphan `tsx` processes — the runner tears down the tree. Re-run scoped checks after fixing; do not stack overlapping `run_ci` calls.

## UI

Panel + lane + agent-chat progress card list **which** checks were selected and **why** (`reason[]`). Click a check name for status + RAD-74 excerpt/log. Elapsed time uses the same `formatElapsed` units as the CLI card. The command line must match what ran (`eslint apps/foo.ts`, not only `lint`).

## CI-resume (locked)

After a blocked export gate: steward `resume_implementor` → implementor fixes and re-runs failing checks → steward `evaluate_export_gate` **again**. Do **not** auto-spawn a reviewer because CI failed. Reviewer still owns product findings (`changes_requested`). Ready-for-human / Push language only on `handoff_human`.

## Red CI retry (RAD-121)

After the **first** `run_ci` / `prgenie ci` plan is selected, print `{ checks, reason }`. If a check goes red:

1. Open the failing log (progress card / `.git/agent-console/ci-logs/<check>.log`).
2. Fix the named assertion or file.
3. Re-run **only that file** (e.g. `pnpm exec tsx --test path/to/file.test.ts`) or **that one check name** (`prgenie ci <id> --failing test:core`) once per edit.
4. Still format the files you edited (`format:check` on the diff / Prettier on touched paths). The ban is **not** “skip format.”

**Do not** relaunch the multi-check scoped plan after a known failure. **Do not** start a second overlapping `run_ci` while one is still running (kill/retry of the whole plan burned ~40 min on RAD-119 dogfood).

### Wrong vs right (RAD-119 dogfood, `lp-a2478356`)

|           | Action                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Wrong** | `test:core` fails → relaunch entire scoped plan (`format:check` + lint/typecheck/test for core+cli). That pulls every `packages/core/src/*.test.ts`; export-gate fixtures alone are ~5 min. Overlapping `run_ci` + kill/retry. |
| **Right** | Print `{ checks, reason }` → open the log → fix the named file → run **only that test file** once → format the edited files → when green, continue (or `--failing` that one check).                                            |

Local full-suite / root `pnpm test` remains banned (RAD-119).
