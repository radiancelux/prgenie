# Troubleshooting

Start with `prgenie doctor` from any worktree of the repo. It reports the checks below. This page expands the tribal failure modes that doctor only summarizes.

## `prgenie doctor` checks

| id                 | Meaning                                                             | Typical fix                                                                     |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `git`              | Not inside a git repo                                               | `cd` into a PR Genie checkout                                                   |
| `plugin-install`   | No Cursor plugin at `~/.cursor/plugins/local/prgenie`               | `pnpm build && pnpm link-plugin`, then disable/enable the plugin                |
| `plugin-stale`     | Installed `mcp/server.cjs` hash ≠ repo build                        | Same as above — **reload alone often keeps a stale MCP tool list**              |
| `extension`        | Local PRs extension missing or wrong version                        | `pnpm build && pnpm link-extension`, then **quit Cursor fully and reopen**      |
| `watch`            | Export-halt record in `watch.json`                                  | Informational — export halt only; listen is removed                             |
| `corrupt-prs`      | Unparsable JSON under `.git/agent-console/prs/`                     | Inspect or delete listed files; `listLocalPrs` skips them silently              |
| `orphan-worktrees` | `.loops/<id>` worktree with no live local PR                        | `git worktree remove <path>` (or reopen/delete the matching loop)               |
| `gh-bind`          | Repo unbound (or no `gh` accounts)                                  | `gh auth login`, then `prgenie gh use <login>`                                  |
| `package-versions` | Monorepo package.json / local VSIX version skew                     | Align versions; `pnpm build && pnpm pack:extension` (see [Release](release.md)) |
| `legacy-push-gate` | Old `push-gate.mjs` still on disk                                   | Delete it (superseded by `github-gate.cjs`) and re-run `pnpm link-plugin`       |
| `mcp-config`       | Installed plugin `mcp.json` invalid, UTF-8 BOM, or `${PLUGIN_ROOT}` | `pnpm link-plugin` (rewrites UTF-8 no BOM + absolute `node` + `server.cjs`)     |
| `mcp-duplicate`    | Workspace `.cursor/mcp.json` and the plugin both name `prgenie`     | Rename workspace server to `prgenie-dev` (or remove it) while the plugin is on  |
| `mcp-node`         | Plugin MCP `command` is missing / not a real file                   | `pnpm link-plugin` pins `node.exe`; or set an absolute Node path                |
| `ci-failure-log`   | Last shepherd/export CI failure (informational)                     | Open the path or `prgenie shepherd <id> --verbose`                              |

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
3. Workspace MCP is **`prgenie-dev`** (live `packages/plugin/mcp/server.cjs`). The plugin server is **`prgenie`**. Enable **one** of them — same-name dual registration can hang Local on Connecting….
4. `link-plugin` pins MCP `server.cjs` + `node.exe` in the copied plugin folder (UTF-8, no BOM) so Cursor does not look for `mcp/server.cjs` in the workspace root.

## Sticky Connecting… / 0 tools (Windows)

**Symptoms:** Customize → Plugins → Configure prgenie → **Environments → Local: Connecting…** forever. Background MCPs list shows `prgenie` with **0 tools enabled**. `/loop` cannot see `steward_next` / `bind_steward`. Manual `node packages/plugin/mcp/server.cjs` sits quietly (that only proves the process starts — it is not a handshake).

**What we verified (RAD-82):**

1. **Stdio framing (root cause).** Official MCP stdio is **newline-delimited JSON**. This server used to reply with LSP `Content-Length` headers and **no trailing newline** after the JSON body. Cursor's Windows host reads one JSON line; it never saw a complete `initialize` result, so the UI stayed on Connecting… with 0 tools. Absolute `node.exe` in `.cursor/mcp.json` could not fix that.
2. **`${PLUGIN_ROOT}` is not expanded** in Cursor. Use `${CURSOR_PLUGIN_ROOT}` in plugin `mcp.json`. `link-plugin` still pins an absolute `server.cjs` path as a fallback.
3. **Dual same-name `prgenie`.** Plugin MCP + workspace `.cursor/mcp.json` both named `prgenie` merge into one Configure dialog (plugin source + Local environment). This repo's workspace server is now **`prgenie-dev`** so the plugin entry can win.
4. **UTF-8 BOM.** Windows PowerShell `Set-Content -Encoding utf8` writes a BOM. `JSON.parse` rejects it. `pin-plugin-mcp.mjs` writes UTF-8 without a BOM.
5. **`node` vs `node.exe`.** Cursor launched from the Start menu may not inherit PATH. `link-plugin` sets `command` to `process.execPath` (`…\nodejs\node.exe`).

**Diagnosis path:**

1. `prgenie doctor` — look at `mcp-config`, `mcp-duplicate`, `mcp-node`, `plugin-stale`.
2. Output panel → **MCP Logs** (Ctrl+Shift+U). Spawn errors (`ENOENT node`, bad path) vs silence (handshake never completed — upgrade / rebuild).
3. Confirm only **one** healthy `prgenie` source: plugin **or** workspace, not both with the same name.
4. `pnpm build && pnpm link-plugin`, then Customize → Plugins → PR Genie **off/on**. Quit Cursor fully if Windows still holds the old `server.cjs`.
5. If you need live-reload without re-link: enable **`prgenie-dev`** and disable the plugin MCP (or vice versa).

`where.exe node` succeeding and a quiet manual `node …\server.cjs` do **not** prove Cursor completed `initialize` / `tools/list`.

## Extension not refreshing

The **Local PRs** sidebar is a VS Code extension, not the Cursor plugin. `link-plugin` does not update it.

1. `pnpm build && pnpm link-extension`
2. Quit Cursor fully and reopen (or F5 **Run PR Genie Extension** for a debug host)

Doctor `extension` fails when the installed version ≠ `packages/extension/package.json`.

## Listen flywheel removed

`prgenie watch start|stop|listen` and MCP `watch_start` / `watch_stop` hard-error and tell you to use `/loop`. There is no inbox/queue listen path.

If `/loop` cannot see `steward_next` / `bind_steward`, MCP is still loading — wait, toggle the plugin, retry. Do not implement in the steward chat and do not arm listen.

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
- Never treat the primary checkout as a disposable loop worktree; never implement Later work in the primary when a loop worktree exists.
- Orphans: `.loops` path still registered in `git worktree list` but no live (non-archived) local PR with that id → `git worktree remove <path>`.
- Worktree collisions: two windows on the same branch, or a leftover `.loops/<other-id>` while coding a different loop — Switch to the correct loop id or remove the stale tree.

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
5. Orchestration → `/loop` (`prgenie steward <id>`). Listen is gone.
6. Export halt stuck → archive/missing export id, or create next loop (export resume only)
7. Wrong GitHub user → `prgenie gh use <login>`
8. Bad packet → inspect `.git/agent-console/prs/<id>.json`

## See also

- [Architecture](architecture.md) — packages, storage, lifecycle, worktrees
- [Root README](../README.md) — install notes and flywheel
- [Plugin README](../packages/plugin/README.md) — link-plugin / MCP refresh
- [Windows dogfood stability RCA](rca-windows-dogfood-stability.md) — watch-listen fan-out, empty Local PRs sidebar, shepherd "hang", Windows tests (analysis; fix slices not shipped)
