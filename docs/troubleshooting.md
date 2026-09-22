# Troubleshooting

Start with `prgenie doctor` from any worktree of the repo. It reports the checks below. This page expands the tribal failure modes that doctor only summarizes.

## `prgenie doctor` checks

| id                 | Meaning                                                                | Typical fix                                                                     |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `git-path`         | `git` not resolvable from this process PATH                            | Install Git / fix PATH, or set `PRGENIE_GIT` to absolute `git.exe`              |
| `git`              | Not inside a git repo                                                  | `cd` into a PR Genie checkout                                                   |
| `plugin-install`   | No Cursor plugin at `~/.cursor/plugins/local/prgenie`                  | `pnpm build && pnpm link-plugin`, then disable/enable the plugin                |
| `plugin-stale`     | Installed `mcp/server.cjs` hash ≠ repo build                           | Same as above — **reload alone often keeps a stale MCP tool list**              |
| `plugin-bundles`   | Repo `mcp/server.cjs` or hooks `.cjs` missing or older than sources    | `pnpm build` (`link-plugin` runs build first)                                   |
| `plugin-dirt`      | Dirty **tracked** `packages/plugin/hooks\|mcp/*.cjs` on primary        | Rare post-gitignore — stash/restore, or rebase off a pre-migration branch       |
| `extension`        | Local PRs extension missing or wrong version                           | `pnpm build && pnpm link-extension`, then **quit Cursor fully and reopen**      |
| `watch`            | Export-halt record in `watch.json`                                     | Informational — export halt only; listen is removed                             |
| `corrupt-prs`      | Unparsable JSON under `.git/agent-console/prs/`                        | Inspect or delete listed files; `listLocalPrs` skips them silently              |
| `orphan-worktrees` | `.loops/<id>` worktree with no live local PR                           | `git worktree remove <path>` (or reopen/delete the matching loop)               |
| `gh-bind`          | Repo unbound (or no `gh` accounts)                                     | `gh auth login`, then `prgenie gh use <login>`                                  |
| `package-versions` | Monorepo package.json / local VSIX version skew                        | Align versions; `pnpm build && pnpm pack:extension` (see [Release](release.md)) |
| `legacy-push-gate` | Old `push-gate.mjs` still on disk                                      | Delete it (superseded by `github-gate.cjs`) and re-run `pnpm link-plugin`       |
| `mcp-config`       | Installed plugin `mcp.json` invalid, UTF-8 BOM, or `${PLUGIN_ROOT}`    | `pnpm link-plugin` (rewrites UTF-8 no BOM + absolute `node` + `server.cjs`)     |
| `mcp-duplicate`    | Workspace `.cursor/mcp.json` registers `prgenie` (same name as plugin) | Delete workspace `mcp.json` (plugin is canonical). Enable **only one** prgenie  |
| `mcp-node`         | Plugin MCP `command` is missing / not a real file                      | `pnpm link-plugin` pins `node.exe`; or set an absolute Node path                |
| `ci-failure-log`   | Last shepherd/export CI failure (informational)                        | Open the path or `prgenie shepherd <id> --verbose`                              |

Example FAIL line:

```text
FAIL  plugin-stale — Installed MCP server (…) differs from repo build (…).
    fix: pnpm build && pnpm link-plugin, then Customize → Plugins → disable/enable PR Genie
```

## Stale MCP / plugin

**Symptoms:** tools missing, old tool schemas, skills behaving like an older build, doctor `plugin-stale`.

**Fix:**

1. From the monorepo: `pnpm build` then `pnpm link-plugin`.
2. In **Customize → Plugins**, turn PR Genie **off and on** (Developer: Reload Window is not enough for the MCP tool list).
3. **Canonical MCP is the plugin** (`prgenie` after `pnpm link-plugin`). This repo does **not** ship `.cursor/mcp.json`. Enable **only that one** entry.
4. `link-plugin` pins MCP `server.cjs` + `node.exe` in the copied plugin folder (UTF-8, no BOM; `cmd /c` when the node path has spaces).
5. **Windows folder lock:** If `Remove-Item` fails because another process still holds `~\.cursor\plugins\local\prgenie` (often MCP `node … server.cjs`), `link-plugin` stops matching node/cmd processes (not all `node.exe`), retries, then renames the folder to `prgenie.old-<timestamp>` and installs into a fresh `prgenie`. Delete old folders later after a full Cursor quit. Optional (aggressive): `powershell -ExecutionPolicy Bypass -File scripts/link-plugin.ps1 -ForceQuitCursor`.

## MCP "not inside a git repository" (Windows / plugin cwd)

**Symptoms:** MCP tools (`list_local_prs`, `create_local_pr`, `steward_next`, …) fail with `Not inside a git repository` until you pass an explicit `cwd` argument. Common when PR Genie runs as a **Cursor plugin** MCP server.

**Cause:** Plugin MCP starts with `process.cwd()` at the **plugin install** (`~/.cursor/plugins/local/prgenie` or `${CURSOR_PLUGIN_ROOT}`), not your open workspace. That directory is not a git repo. Hooks get `workspace_roots` / `$CURSOR_PROJECT_DIR`; MCP tools must resolve the workspace the same way.

**Fix / expectations:**

1. Rebuild and relink after upgrading: `pnpm build && pnpm link-plugin`, then disable/enable PR Genie.
2. In the happy path, omit `cwd` — tools resolve the workspace git root from `$CURSOR_PROJECT_DIR` or `$WORKSPACE_FOLDER_PATHS` (first folder).
3. When implementing in a **loop worktree** (`../<repo>.loops/<id>`), pass `cwd` to that worktree path (same as before).
4. If the error names an expected root but you are outside any repo, open the project folder in Cursor or pass `cwd` explicitly.

Example error (outside repo):

```text
Not inside a git repository. Expected workspace git root at C:\Users\you\repo. MCP server cwd is the plugin install (…), not the workspace. Tried: …
```

## Sticky Connecting… / 0 tools (Windows)

**Symptoms:** Customize → Plugins → Configure prgenie → **Environments → Local: Connecting…** forever. Connected MCPs shows `prgenie` with **0 tools**. `/steward` cannot see `steward_next` / `bind_steward`. Manual `node packages/plugin/mcp/server.cjs` sits quietly (that only proves the process starts — it is not a handshake).

**Two `prgenie` rows (enable only one):**

When the plugin is off, Connected MCPs can still list **two** disabled servers both named `prgenie`:

1. Tag **Plugin** — `~/.cursor/plugins/local/prgenie` (`mcp.json` → server id `prgenie`)
2. Tag **pr-genie** (or your folder name) — workspace `.cursor/mcp.json` that also used server id `prgenie`

Same server id, two sources. Enabling both (or leaving a stale workspace `prgenie` while the plugin is on) is enough to confuse Configure → Local. **Dogfood canonical path is the plugin.** This repo no longer ships `.cursor/mcp.json`. Delete any leftover workspace file, or rename that server to something other than `prgenie`, then enable **only** the Plugin row.

A single Plugin row can still hang — dual registration is necessary to clean up, not sufficient as the only cause.

**What we verified (RAD-82):**

1. **Stdio framing.** Official MCP stdio is **newline-delimited JSON**. This server used to reply with LSP `Content-Length` and **no trailing newline**. Cursor's Windows host never saw a complete `initialize` → Connecting… / 0 tools. Replies are NDJSON + `fs.writeSync(1, …)` so piped stdout is not block-buffered. Incoming initialize without a newline is also accepted.
2. **`${PLUGIN_ROOT}` is not expanded** in Cursor. Use `${CURSOR_PLUGIN_ROOT}`. `link-plugin` pins an absolute `server.cjs`.
3. **Dual same-name `prgenie`.** Plugin + workspace `.cursor/mcp.json` both named `prgenie` → two Connected rows (Plugin vs folder tag). Workspace file is **not shipped**.
4. **UTF-8 BOM.** PowerShell `Set-Content -Encoding utf8` writes a BOM. `pin-plugin-mcp.mjs` writes UTF-8 without a BOM.
5. **`node` vs `node.exe` / spaces.** Start-menu Cursor may miss PATH. `C:\Program Files\nodejs\node.exe` can be split at the space. `link-plugin` pins `process.execPath`, and wraps with `cmd /c` when the path has spaces.
6. **Cursor sandbox log.** `[info] [cursor-mcp] Sandbox prerequisites configured for stdio MCP: supported=false` is **normal on Windows** (no stdio sandbox). It is not a server crash. If logs also say `MCP stdio sandbox unavailable` / `The server was not started` / `unsupported_platform`, Cursor never spawned us (team MCP Network Controls). Ask an admin to allowlist `*node* *server.cjs*` with network mode **No sandbox**, or confirm User MCP extensions. Remote HTTP MCPs (GitHub, Linear, …) skip this sandbox and still connect.

**Diagnosis path:**

1. `prgenie doctor` — `mcp-config`, `mcp-duplicate`, `mcp-node`, `plugin-stale`.
2. `prgenie mcp --smoke` (or `node packages/cli/dist/prgenie.cjs mcp --smoke`) — must print `steward_next: true` in under a few seconds. That is the same `initialize` / `tools/list` Cursor needs. If smoke passes and Cursor still shows 0 tools, Cursor did not complete stdio (spawn/sandbox), not a hang inside our tool catalog.
3. Output → **MCP Logs**. Look for `[prgenie] mcp stdio ready` on stderr after toggle. Only `supported=false` with **no** ready line → process never started. `server was not started` / `unsupported_platform` → sandbox policy. `ENOENT` → PATH/`node`. Ready + still Connecting → framing (rebuild this branch).
4. Connected MCPs: **one** `prgenie` row, tag **Plugin**. If you also see tag **pr-genie**, delete `.cursor/mcp.json`.
5. `pnpm build && pnpm link-plugin` (unlocks or renames a locked plugin folder — see Stale MCP above), then Customize → Plugins → PR Genie **off/on**.
6. Do not add a workspace `prgenie` for live-reload. If you must, use a **different** server id and keep the plugin off.

`where.exe node` succeeding and a quiet manual `node …\server.cjs` do **not** prove Cursor completed `initialize` / `tools/list`.

## Extension not refreshing

The **Local PRs** sidebar is a VS Code extension, not the Cursor plugin. `link-plugin` does not update it.

1. `pnpm build && pnpm link-extension`
2. Quit Cursor fully and reopen (or F5 **Run PR Genie Extension** for a debug host)

Doctor `extension` fails when the installed version ≠ `packages/extension/package.json`.

## Listen flywheel removed

`prgenie watch start|stop|listen` and MCP `watch_start` / `watch_stop` hard-error and tell you to use `/steward`. There is no inbox/queue listen path.

If `/steward` cannot see `steward_next` / `bind_steward`, MCP is still loading — wait, toggle the plugin, retry. Do not implement in the steward chat and do not arm listen.

`prgenie watch` / MCP `watch_status` still show the export-halt record. Creating a new loop resumes an **export** halt after that id is archived or missing.

Reviewer dispatch uses `claim_review` / `prgenie claim-review` so a second pass cannot Task another reviewer for the same `id`+`headSha`.

## Head drift

When status becomes `ready` with Review requested, core stores `reviewRequestedSha`. If commits land before `complete_review`, complete fails with a head-drift error unless you pass `--force` / `allowDrift`.

**What to do:** stay on `ready`, re-diff, file any new findings, then `complete_review` again. Use force only when you intentionally finalize on the new HEAD.

## Export / `gh` bind

- There is **no push / `gh pr create` without** `/export` (or the panel **Open on GitHub** path that calls the same export). Agents are steered and hooked away from ad-hoc push.
- Repo must be bound: `prgenie gh list`, then `prgenie gh use <login>`. Wrong account → push/PR lands under the wrong GitHub user (`gh auth` is global).
- Export archives the loop (`approved`), removes `../<repo>.loops/<id>` when safe, and checks the primary workspace off the loop branch onto the loop base.
- If export fails late on auth, fix bind and retry — do not hand-roll `git push`.

## Corrupt PR JSON

Doctor `corrupt-prs` lists unparsable files under `.git/agent-console/prs/`. Core skips them when listing. Inspect the file, restore from backup if you have one, or delete the bad JSON after confirming the loop is disposable. Refs under `refs/local-pr/<id>/` may still exist — clean those if you delete the packet.

## Orphan worktrees / primary vs `.loops`

- Loop checkouts live at `../<repo>.loops/<id>` next to the primary folder.
- Never treat the primary checkout as a disposable loop worktree; never implement loop work in the primary when a loop worktree exists — Switch into `.loops/<id>` after create.
- Orphans: `.loops` path still registered in `git worktree list` but no live (non-archived) local PR with that id → `git worktree remove <path>`.

## Worktree CI toolchain (Windows)

**Symptoms:** `run_ci` / shepherd in a `.loops/<id>` worktree fails with `eslint` / `tsc` / `tsx` “not recognized”, `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`, or “Missing toolchain in worktree”.

**Cause:** Exclusive loop worktrees do not copy `node_modules`. RAD-112 correctly runs CI **in** the worktree; without deps, bins are missing.

**Happy path (RAD-92):** Before checks, PR Genie **junctions** primary `node_modules` into the worktree on Windows (`mklink /J` equivalent via `fs.symlink(..., "junction")` — no admin). On macOS/Linux it uses a directory symlink. Prefer this over a full install per loop.

**Fix:**

1. In the **primary** checkout: `pnpm install` (once).
2. Re-run `prgenie ci <id>` / MCP `run_ci` — junction is created automatically.
3. If junction is impossible (rare cross-device / permission): `cd ../<repo>.loops/<id> && pnpm install`.
4. Product lint/test failures still hard-block export. A pure **CI environment unhealthy** setup error is soft-surfaced and does **not** hard-block export by default (see [ci-checks.md](ci-checks.md#worktree-deps-rad-92)).

- Worktree collisions: two windows on the same branch, or a leftover `.loops/<other-id>` while coding a different loop — Switch to the correct loop id or remove the stale tree.
- Bundled MCP/hook `.cjs` outputs are **gitignored** and produced by `pnpm build` / `link-plugin` / CI — not committed. Doctor `plugin-bundles` fails when they are missing or older than sources.
- Dirty **tracked** plugin bundles on primary (pre-migration branch still tracking `packages/plugin/hooks|mcp/*.cjs`): doctor `plugin-dirt` / `create_local_pr` refuse until stash or `git restore`. Peel would otherwise carry that dirt into the new loop worktree. On current `main`, those paths should not appear in `git status` after a rebuild.

## Git missing from PATH (MCP / CLI spawn)

**Symptoms:** MCP or CLI fails with `GitBinaryError` / `git is not resolvable from this process` (ENOENT on spawn).

**Fix:** Install [Git for Windows](https://git-scm.com/download/win) (or git on macOS/Linux) and ensure `git` / `git.exe` is on PATH for the Cursor process. Or set `PRGENIE_GIT` to the absolute path of the binary (e.g. `C:\Program Files\Git\cmd\git.exe`). Doctor check `git-path` prints the same hint. Core already pins well-known Windows install locations when PATH is empty — this error means those also failed.

## Version / VSIX skew

Doctor `package-versions` fails when root / `packages/*/package.json` disagree, or when a local `packages/extension/prgenie-*.vsix` name or embedded manifest lags the extension version.

**Fix:** set every listed `package.json` to the same version, then `pnpm build && pnpm check-versions && pnpm pack:extension`. VSIX files are gitignored — pack on demand (see [Release](release.md)). For the installed sidebar, still run `pnpm link-extension` and quit Cursor fully.

## Shepherd / export CI failure toast

A blocked export used to toast only `Command failed: pnpm test`. The toast, CLI `prgenie shepherd` / `prgenie export`, and sidebar reasons now include the **check name** (format/lint/typecheck/test/build) and a **short excerpt** (first failing test name when parseable, otherwise the last few stderr/stdout lines). The capped full log is written to `.git/agent-console/ci-logs/<check>.log`. Doctor `ci-failure-log` names that path; `prgenie shepherd <id> --verbose` prints it.

## Legacy push-gate

If `packages/plugin/hooks/push-gate.mjs` exists, doctor fails `legacy-push-gate`. It is not registered in `hooks.json` anymore; delete the file and re-link the plugin so only `github-gate.cjs` runs.

## Quick recovery checklist

1. `prgenie doctor`
2. Stale plugin → build + `link-plugin` + disable/enable
3. Sticky Connecting… / 0 tools → `mcp-config` / `mcp-duplicate` / `mcp-node` + Output → MCP Logs (see above)
4. Stale sidebar → `link-extension` + full quit
5. Orchestration → `/steward` (`prgenie steward <id>`). Listen is gone.
6. Export halt stuck → archive/missing export id, or create next loop (export resume only)
7. Wrong GitHub user → `prgenie gh use <login>`
8. Bad packet → inspect `.git/agent-console/prs/<id>.json`

## See also

- [Architecture](architecture.md) — packages, storage, lifecycle, worktrees
- [Root README](../README.md) — install notes and flywheel
- [Plugin README](../packages/plugin/README.md) — link-plugin / MCP refresh
- [Windows dogfood stability RCA](rca-windows-dogfood-stability.md) — watch-listen fan-out, empty Local PRs sidebar, shepherd "hang", Windows tests (analysis; fix slices not shipped)
