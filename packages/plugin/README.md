# PR Genie Cursor Plugin

Local pull requests for agent work. GitHub when you say so.

This folder is a Cursor Plugin (`/.cursor-plugin/plugin.json`). After `pnpm build` at the repo root (produces `mcp/server.cjs`), copy it:

```powershell
pnpm link-plugin
```

`mcp.json` uses `${PLUGIN_ROOT}/mcp/server.cjs`. Cursor currently resolves a relative `./mcp/server.cjs` against the **workspace**, which 404s. `link-plugin` rewrites the installed copy to an absolute path.

Then **Developer: Reload Window** is not enough for MCP tools (Cursor caches the first tool list). In **Customize → Plugins**, disable and re-enable PR Genie. Confirm:

- Rule: do not push / open GitHub PRs
- Command (skills, one slash name each): `/start-loop`, `/local-pr`, `/review-local-pr`, `/watch-ready-prs`, `/watch-review-inbox`, `/review-queue`, `/review-inbox`, `/stop-loop`, `/stop-review`, `/stop-watch`, `/export-local-pr`
- Do not add `commands/*.md` that duplicate a skill name — Cursor lists both and the user sees two `/start-loop` entries.
- MCP server: `prgenie`
- Hooks: push-gate, session log, **review loop** (`sessionStart` injects comments only when status is `changes_requested`; `stop` prompts a reviewer Task when the loop is `ready`; `subagentStop` returns those comments to this chat), **subagentStop capture**

Each loop has a feature branch for export and a git worktree. **Switch** in Local PRs replaces this window with that checkout. When a loop is **reviewed**, **Export to GitHub** on the loop panel publishes it. Exported (`approved`) loops are archived: they stay on disk. **Show archived** in Local PRs lists them. A merged GitHub PR archives the matching local packet. Export also checks the main workspace off the loop branch and drops a sibling `.loops` checkout. The plugin still asks before `git push` / `gh pr create`.

Listen loops cap at **60 ticks** (~1 hour), then halt that chat's lane only (`/stop-loop` or `/stop-review`). Re-run `/watch-review-inbox` or `/watch-ready-prs` to continue. `/stop-watch` stops both sooner.
