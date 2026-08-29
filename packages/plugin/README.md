# PR Genie Cursor Plugin

Local pull requests for agent work. GitHub when you say so.

This folder is a Cursor Plugin (`/.cursor-plugin/plugin.json`). After `pnpm build` at the repo root (produces `mcp/server.cjs`), copy it:

```powershell
pnpm link-plugin
```

`mcp.json` uses `${PLUGIN_ROOT}/mcp/server.cjs`. Cursor currently resolves a relative `./mcp/server.cjs` against the **workspace**, which 404s. `link-plugin` rewrites the installed copy to an absolute path.

Then **Developer: Reload Window**, open **Customize**, and confirm:

- Rule: do not push / open GitHub PRs
- Command: `/start-loop`, `/local-pr`, `/review-local-pr`, **`/watch-ready-prs`**, **`/watch-review-inbox`**, **`/stop-watch`**, **`/export-local-pr`**
- MCP server: `prgenie`
- Hooks: push-gate, session log, **review loop** (`sessionStart` injects comments only when status is `changes_requested`; `stop` Tasks a reviewer when the loop is `ready`; `subagentStop` returns those comments to this chat), **subagentStop capture**

Each loop has a feature branch for export and a git worktree. **Switch** in Local PRs replaces this window with that checkout. When a loop is **reviewed**, **Export to GitHub** on the loop panel publishes it. Exported (`approved`) loops are archived: they stay on disk but leave the Local PRs list. A merged GitHub PR archives the matching local packet. Export also checks the main workspace off the loop branch and drops a sibling `.loops` checkout. The plugin still asks before `git push` / `gh pr create`.
