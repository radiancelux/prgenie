# PR Genie Cursor Plugin

Local pull requests for agent work. GitHub when you say so.

This folder is a Cursor Plugin (`/.cursor-plugin/plugin.json`). Generated `mcp/server.cjs` and `hooks/*.cjs` are **gitignored** — build them at the repo root, then copy:

```powershell
pnpm build          # or just pnpm link-plugin (runs build first)
pnpm link-plugin
```

Clean clone path: install → build → link-plugin → Customize → Plugins → PR Genie off/on. There is no pre-committed `server.cjs`.

If a PR still shows huge ±tens-of-thousands-line diffs on those `.cjs` files, you have a dirty local build against an old tracked copy, or you are on a pre-migration branch — rebuild or rebase; that is not product source.

`mcp.json` uses `${CURSOR_PLUGIN_ROOT}/mcp/server.cjs` (Cursor does **not** expand `${PLUGIN_ROOT}`). A relative `./mcp/server.cjs` resolves against the **workspace**, which 404s. `link-plugin` rewrites the installed copy to an absolute `node.exe` + `server.cjs` (UTF-8, no BOM; `cmd /c` when the node path has spaces). **Do not ship** a workspace `.cursor/mcp.json` named `prgenie` — that creates a second Connected MCP row tagged with the folder name.

Then **Developer: Reload Window** is not enough for MCP tools (Cursor caches the first tool list). In **Customize → Plugins**, disable and re-enable PR Genie. Confirm:

- Rule: do not push / open GitHub PRs
- Command (skills, one slash name each): `/steward`, `/start`, `/local-pr`, `/review`, `/export`
- Do not add `commands/*.md` that duplicate a skill name — Cursor lists both and the user sees two `/start` entries.
- MCP server: `prgenie`
- Hooks: github-gate, session log, **review loop** (`sessionStart` / `subagentStop` inject pending comments when status is `changes_requested`; no stop-hook reviewer spawn), **subagentStop capture** (off by default; `PRGENIE_CAPTURE_SUBAGENT=1`)

Each loop has a feature branch for export and a git worktree. **Switch** in Local PRs replaces this window with that checkout. When a loop is **reviewed**, **Export to GitHub** on the loop panel publishes it. Exported (`approved`) loops are archived: they stay on disk. **Show archived** in Local PRs lists them. A merged GitHub PR archives the matching local packet. Export also checks the main workspace off the loop branch and drops a sibling `.loops` checkout. The plugin still asks before `git push` / `gh pr create`.

Orchestration is **`/steward`** (one steward, durable Task ids, export gate before Push to origin). There is no inbox/queue listen flywheel. Reviewer Tasks require a durable `claim_review` for that `id`+`headSha`.

## Docs

Repo docs (from monorepo root):

- [Architecture](../../docs/architecture.md)
- [Default review bar](../../docs/review-bar.md) — `/review` process bar + `.prgenie/review.md`
- [Troubleshooting](../../docs/troubleshooting.md) — stale MCP, extension refresh, watch halt/idle, export/bind
