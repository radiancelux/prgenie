# PR Genie Cursor Plugin

Local pull requests for agent work. GitHub when you say so.

This folder is a Cursor Plugin (`/.cursor-plugin/plugin.json`). After `pnpm build` at the repo root (produces `mcp/server.cjs`), copy it:

```powershell
pnpm link-plugin
```

`mcp.json` uses `${CURSOR_PLUGIN_ROOT}/mcp/server.cjs` (Cursor does **not** expand `${PLUGIN_ROOT}`). A relative `./mcp/server.cjs` resolves against the **workspace**, which 404s. `link-plugin` rewrites the installed copy to an absolute `node.exe` + `server.cjs` (UTF-8, no BOM). Workspace `.cursor/mcp.json` is `prgenie-dev` so it does not collide with plugin `prgenie`.

Then **Developer: Reload Window** is not enough for MCP tools (Cursor caches the first tool list). In **Customize → Plugins**, disable and re-enable PR Genie. Confirm:

- Rule: do not push / open GitHub PRs
- Command (skills, one slash name each): `/loop`, `/start`, `/local-pr`, `/review`, `/export`
- Do not add `commands/*.md` that duplicate a skill name — Cursor lists both and the user sees two `/start` entries.
- MCP server: `prgenie`
- Hooks: github-gate, session log, **review loop** (`sessionStart` / `subagentStop` inject pending comments when status is `changes_requested`; no stop-hook reviewer spawn), **subagentStop capture**

Each loop has a feature branch for export and a git worktree. **Switch** in Local PRs replaces this window with that checkout. When a loop is **reviewed**, **Export to GitHub** on the loop panel publishes it. Exported (`approved`) loops are archived: they stay on disk. **Show archived** in Local PRs lists them. A merged GitHub PR archives the matching local packet. Export also checks the main workspace off the loop branch and drops a sibling `.loops` checkout. The plugin still asks before `git push` / `gh pr create`.

Orchestration is **`/loop`** (one steward, durable Task ids, export gate before Push to origin). There is no inbox/queue listen flywheel. Reviewer Tasks require a durable `claim_review` for that `id`+`headSha`.

## Docs

Repo docs (from monorepo root):

- [Architecture](../../docs/architecture.md)
- [Troubleshooting](../../docs/troubleshooting.md) — stale MCP, extension refresh, watch halt/idle, export/bind
