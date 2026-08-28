# PR Genie Cursor Plugin

Local pull requests for agent work. GitHub when you say so.

This folder is a Cursor Plugin (`/.cursor-plugin/plugin.json`). After `pnpm build` at the repo root (produces `mcp/server.cjs`), copy it:

```powershell
pnpm link-plugin
```

`mcp.json` uses `${PLUGIN_ROOT}/mcp/server.cjs`. Cursor currently resolves a relative `./mcp/server.cjs` against the **workspace**, which 404s. `link-plugin` rewrites the installed copy to an absolute path.

Then **Developer: Reload Window**, open **Customize**, and confirm:

- Rule: do not push / open GitHub PRs
- Command: `/local-pr`
- MCP server: `prgenie`
- Hooks: push-gate, session log, **subagentStop capture** (drafts a local PR when a child agent commits)

Worktrees stay in Cursor, GitLens, or Conductor. This plugin only creates local PR packets and asks before `git push` / `gh pr create`.
