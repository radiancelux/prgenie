# PR Genie

Local pull requests for agent work. GitHub when you say so.

PR Genie is a **pre-GitHub review lane** for Cursor (and any git checkout, including Conductor workspaces and GitLens worktrees). It does not manage worktrees. Cursor, GitLens, and Conductor already do that.

A local PR is a git-native review packet: branch, base, diff, comments, and status. It never leaves the machine until you export it. Agents are steered — and hooked — away from `git push` / `gh pr create`.

When a **subagent** finishes with commits, PR Genie drafts a packet and puts it on the developer's watch list. Cursor still manages the subagents. The sidebar is the spectator GUI.

## What it is

| Piece | Role |
| --- | --- |
| `@prgenie/core` + `prgenie` CLI | Create/list/approve local PRs from any worktree |
| Cursor Plugin | No-push rule, `/local-pr`, MCP, subagent capture, **per-repo `gh` account** |
| VS Code / Cursor extension | Live watch list as packets land — not a worktree manager |

## What it is not

- Not a worktree manager (no create / apply / delete)
- Not a subagent orchestrator (Cursor's Task tool owns spawn/stop)
- Not a GitHub PR client (GitLens owns remote PRs after export)
- Not a Conductor replacement

## Install (dev)

Requires Node 20+ and git.

```powershell
pnpm install
pnpm build
pnpm test
pnpm link-plugin
```

Then:

1. **CLI** — `pnpm cli --help` or `node packages/cli/dist/prgenie.cjs list`
2. **Cursor Plugin** — Reload Window, open Customize, confirm PR Genie (rules, `/local-pr`, MCP `prgenie`)
3. **Sidebar** — F5 (`Run PR Genie Extension`) against a real git repo. Rebuild first with `pnpm build` (or Ctrl+Shift+B) if you changed extension code.

Junction target: `%USERPROFILE%\.cursor\plugins\local\prgenie` (real copy of `packages/plugin`). `link-plugin` pins MCP `server.cjs` to that folder so Cursor does not look for `mcp/server.cjs` in the workspace.

## CLI

```text
prgenie create [--title t] [--body b] [--base main] [--head branch]
prgenie list
prgenie show <id>
prgenie diff <id>
prgenie approve <id>
prgenie request-changes <id> -m "..."
prgenie worktrees
prgenie gh list
prgenie gh use <login>
```

Bind a GitHub login per repo (`prgenie gh use <login>`). Before `git push` / `gh`, PR Genie switches `gh` to that account. `gh auth` is global — only one account is active at a time — so the bind is how this project stays on `radiancelux` instead of `ccc-radiancelux`.

Works from a Conductor workspace or any other worktree — same repo git dir.

## Storage (git-native)

- `refs/local-pr/<id>/head` and `refs/local-pr/<id>/base`
- Notes on `refs/notes/local-pr`
- Metadata in `.git/agent-console/` (not committed)

Cursor may auto-clean worktrees. The packet remains.

## Status

`draft` → `ready` → `approved` | `changes_requested`

Export to GitHub is an explicit later step (not in this slice).

## License

MIT
