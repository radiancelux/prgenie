# Troubleshooting

Start with `prgenie doctor` from any worktree of the repo. It reports the checks below. This page expands the tribal failure modes that doctor only summarizes.

## `prgenie doctor` checks

| id                 | Meaning                                               | Typical fix                                                                     |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `git`              | Not inside a git repo                                 | `cd` into a PR Genie checkout                                                   |
| `plugin-install`   | No Cursor plugin at `~/.cursor/plugins/local/prgenie` | `pnpm build && pnpm link-plugin`, then disable/enable the plugin                |
| `plugin-stale`     | Installed `mcp/server.cjs` hash ≠ repo build          | Same as above — **reload alone often keeps a stale MCP tool list**              |
| `extension`        | Local PRs extension missing or wrong version          | `pnpm build && pnpm link-extension`, then **quit Cursor fully and reopen**      |
| `watch`            | Inbox/queue listening or halted                       | Informational — see [Watch listen DONE / idle](#watch-listen-done--idle)        |
| `corrupt-prs`      | Unparsable JSON under `.git/agent-console/prs/`       | Inspect or delete listed files; `listLocalPrs` skips them silently              |
| `orphan-worktrees` | `.loops/<id>` worktree with no live local PR          | `git worktree remove <path>` (or reopen/delete the matching loop)               |
| `gh-bind`          | Repo unbound (or no `gh` accounts)                    | `gh auth login`, then `prgenie gh use <login>`                                  |
| `package-versions` | Monorepo package.json / local VSIX version skew       | Align versions; `pnpm build && pnpm pack:extension` (see [Release](release.md)) |
| `legacy-push-gate` | Old `push-gate.mjs` still on disk                     | Delete it (superseded by `github-gate.cjs`) and re-run `pnpm link-plugin`       |

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
3. This repo's `.cursor/mcp.json` can point at live `packages/plugin/mcp/server.cjs` — approve it if Cursor prompts.
4. `link-plugin` pins MCP `server.cjs` to the plugin folder so Cursor does not look for `mcp/server.cjs` in the workspace root.

## Extension not refreshing

The **Local PRs** sidebar is a VS Code extension, not the Cursor plugin. `link-plugin` does not update it.

1. `pnpm build && pnpm link-extension`
2. Quit Cursor fully and reopen (or F5 **Run PR Genie Extension** for a debug host)

Doctor `extension` fails when the installed version ≠ `packages/extension/package.json`.

## Watch listen DONE / idle

`prgenie watch listen` (used by `/watch-review-inbox` and `/watch-ready-prs`) eventually prints `AGENT_LOOP_DONE_*` with a reason:

| reason   | Meaning                                                        | What to do                                                                                                                                              |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`   | No activity for ~30m (default)                                 | Re-run the watch skill for that lane                                                                                                                    |
| `max`    | Hit ~8h wall clock                                             | Re-run the watch skill                                                                                                                                  |
| `ticks`  | Hit `--ticks` ceiling                                          | Re-run or raise ticks                                                                                                                                   |
| `stop`   | Lane halted via `/stop-loop`, `/stop-review`, or `/stop-watch` | `prgenie watch start inbox\|queue` or re-run the skill (skills call start)                                                                              |
| `export` | Halted because a loop was exported                             | Resume only after that export id is **archived or missing** (creating a new loop does this for export halts). A `stop` halt is never cleared by create. |

Lane cheat sheet:

- `/stop-loop` → stops **inbox** only
- `/stop-review` → stops **queue** only
- `/stop-watch` → stops both
- Export → halts **both** with reason `export` and the exported id

Check with `prgenie watch` / MCP `watch_status`.

## Head drift

When status becomes `ready` with Review requested, core stores `reviewRequestedSha`. If commits land before `complete_review`, complete fails with a head-drift error unless you pass `--force` / `allowDrift`.

**What to do:** stay on `ready`, re-diff, file any new findings, then `complete_review` again. Use force only when you intentionally finalize on the new HEAD.

## Export / `gh` bind

- There is **no push / `gh pr create` without** `/export-local-pr` (or the panel **Open on GitHub** path that calls the same export). Agents are steered and hooked away from ad-hoc push.
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

## Legacy push-gate

If `packages/plugin/hooks/push-gate.mjs` exists, doctor fails `legacy-push-gate`. It is not registered in `hooks.json` anymore; delete the file and re-link the plugin so only `github-gate.cjs` runs.

## Quick recovery checklist

1. `prgenie doctor`
2. Stale plugin → build + `link-plugin` + disable/enable
3. Stale sidebar → `link-extension` + full quit
4. Watch quiet → re-run `/watch-review-inbox` or `/watch-ready-prs`
5. Export halt stuck → archive/missing export id, or create next loop (export resume only)
6. Wrong GitHub user → `prgenie gh use <login>`
7. Bad packet → inspect `.git/agent-console/prs/<id>.json`

## See also

- [Architecture](architecture.md) — packages, storage, lifecycle, worktrees
- [Root README](../README.md) — install notes and flywheel
- [Plugin README](../packages/plugin/README.md) — link-plugin / MCP refresh
