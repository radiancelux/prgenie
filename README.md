# PR Genie

Local pull requests for agent work. GitHub when you say so.

PR Genie is a **pre-GitHub review lane** for Cursor (and any git checkout, including Conductor workspaces and GitLens worktrees). Each loop gets a feature branch (never the repo base) and a git worktree so you can switch this window onto the implementor's files.

A local PR is a git-native review loop: branch, base, diff, comments, and status. It never leaves the machine until you export it. Agents are steered — and hooked — away from `git push` / `gh pr create`.

When a **subagent** finishes with commits, PR Genie drafts a loop and puts it on the developer's watch list. Cursor still manages the subagents. The sidebar is the spectator GUI. An implementor chat starts with `/start-loop`: a ClickUp/Jira/Linear ticket or a brief typed in chat, then a feature branch and a local PR.

## What it is

| Piece | Role |
| --- | --- |
| `@prgenie/core` + `prgenie` CLI | Create/list/approve local PRs from any worktree |
| Cursor Plugin | No-push rule, `/local-pr`, `/review-local-pr`, MCP, subagent capture, **per-repo `gh` account** |
| VS Code / Cursor extension | Live watch list as loops land — Switch puts this window on that loop's worktree |

## What it is not

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
pnpm link-extension
```

Then:

1. **CLI** — `pnpm cli --help` or `node packages/cli/dist/prgenie.cjs list`
2. **Cursor Plugin** (rules, `/local-pr`, MCP) — `link-plugin` copies to `%USERPROFILE%\.cursor\plugins\local\prgenie`. A reload often **does not** refresh the MCP tool list. In **Customize → Plugins**, turn PR Genie **off and on**. This repo also has `.cursor/mcp.json` so the workspace MCP is the live `packages/plugin/mcp/server.cjs` (approve it if Cursor prompts).
3. **Sidebar / Local PRs** — that is a **VS Code extension**, not the plugin. `link-plugin` does not update it. Run `pnpm link-extension`, then **quit Cursor fully and reopen** (or F5 `Run PR Genie Extension` for a debug host).

`link-plugin` pins MCP `server.cjs` to the plugin folder so Cursor does not look for `mcp/server.cjs` in the workspace root.

## CLI

```text
prgenie create [--title t] [--body "summary"] [--base main] [--head branch]
prgenie queue
prgenie inbox
prgenie update <id> [--title t] [--body "summary"]
prgenie list [--all]
prgenie show <id>
prgenie diff <id>
prgenie approve <id>
prgenie comment <id> -m "..." [--role human|agent|reviewer]
prgenie address <id> <commentId> -m "..."
prgenie resolve <id> <commentId> -m "..."
prgenie complete-review <id>
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

Cursor may auto-clean worktrees. The loop remains.

## Status

`draft` → `ready` (reviewer may file comments) → `complete_review` → `changes_requested` or `reviewed` → `approved`

Reviewer comments stay on `ready` until **`complete_review`**. That flip is what wakes the implementor (`changes_requested`) or you (`reviewed`). Human comments still request changes immediately. The implementor **addresses** each open finding with a reply under that comment (`address_comment`). Addressing the **last** open finding sets `ready` and posts Review requested so the reviewer queue can run again. The reviewer **resolves** addressed comments, then **always** `complete_review`. The **reviewer chat** runs `/watch-ready-prs`. The **implementor chat** runs `/watch-review-inbox` and must not act while the loop is still `ready`. Listen loops cap at 60 ticks (~1 hour), then halt that lane — re-run `/watch-review-inbox` or `/watch-ready-prs` to `watch start` that lane only. `/stop-loop` stops the implementor listen only (`prgenie watch stop inbox`). `/stop-review` stops the reviewer listen only. `/stop-watch` stops both. `/export-local-pr` opens the GitHub PR at origin, **archives** the loop (`approved`), and **halts** listen loops until `create_local_pr` runs after that export id is archived (or missing). Archived packets stay on disk (`prgenie show <id>`, `refs/local-pr/*`, Local PRs **Show archived**) but drop off `prgenie list` and MCP `list_local_prs` unless you pass `--all` / `all=true`. Export checks the **main workspace** off the loop branch (onto the loop base) and removes a sibling `../<repo>.loops/<id>` checkout. If this window is still on that extra worktree, PR Genie reopens the primary folder and then clears it. Every loop should have a **summary** (`body`): why, what changed, how to test.

## License

MIT
