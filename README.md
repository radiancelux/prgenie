# PR Genie

Local pull requests for agent work. GitHub when you say so.

PR Genie is a **pre-GitHub review lane** for Cursor (and any git checkout, including Conductor workspaces and GitLens worktrees). Each loop gets a feature branch (never the repo base) and a git worktree so you can switch this window onto the implementor's files.

A local PR is a git-native review loop: branch, base, diff, comments, and status. It never leaves the machine until you export it. Agents are steered — and hooked — away from `git push` / `gh pr create`.

When a **subagent** finishes with commits, PR Genie drafts a loop and puts it on the developer's watch list. Cursor still manages the subagents. The sidebar is the spectator GUI. Hand **one steward** a ticket with `/loop`: it Tasks an implementor, then a reviewer, resumes the same implementor on `changes_requested`, and only hands off to you for Push to origin after the export gate (shepherd CI) is green. `/start` remains the implementor-only entry. There is no inbox/queue listen flywheel.

## What it is

| Piece                           | Role                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `@prgenie/core` + `prgenie` CLI | Create/list/approve local PRs from any worktree                                        |
| Cursor Plugin                   | No-push rule, `/local-pr`, `/review`, MCP, subagent capture, **per-repo `gh` account** |
| VS Code / Cursor extension      | Live watch list as loops land — Switch puts this window on that loop's worktree        |

## What you can do today

**How to dogfood the agent flywheel** (preferred):

1. **Refresh the plugin** so MCP lists `steward_next` / `bind_steward`: `pnpm build && pnpm link-plugin`, then Customize → Plugins → PR Genie off/on. If Configure → Local stays on **Connecting…** (0 tools), see [Troubleshooting — sticky Connecting](docs/troubleshooting.md#sticky-connecting--0-tools-windows). Do not implement in the `/loop` chat.
2. **`/loop`** with a ticket URL or brief. You are talking to the **steward**. It creates the packet, Tasks an implementor, then a reviewer, resumes the same implementor on `changes_requested`, and runs the export gate.
3. **Push to origin** only when the steward says `handoff_human` (or the loop panel shows Push to origin). Run `/export` or **Open on GitHub**.

`/start` is implementor-only (you code here; you do not orchestrate). Do not run `/watch-inbox`, `/watch-ready`, or `prgenie watch start|listen` — those are gone.

**Control plane** (attach an existing CloudAgent or GitHub PR, then shepherd):

1. **Bind GitHub** (if needed): `prgenie gh use <your-login>`
2. **Attach**: `prgenie attach <pr-url|branch>`
3. **Shepherd**: `prgenie shepherd <id>` — **ready** = gates pass; **blocked** = which gate failed
4. After plugin changes: `pnpm link-plugin` then `prgenie doctor`

Run `prgenie attach --help` and `prgenie --help` for full command reference.

## Docs

- [Architecture](docs/architecture.md) — packages, lifecycle, steward flywheel, storage, worktrees, `gh` bind
- [Troubleshooting](docs/troubleshooting.md) — `prgenie doctor` checks and common failure modes
- [Release](docs/release.md) — version alignment, `check-versions`, `pack:extension`

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
2. **Cursor Plugin** (rules, `/local-pr`, MCP) — `link-plugin` copies to `%USERPROFILE%\.cursor\plugins\local\prgenie`. A reload often **does not** refresh the MCP tool list. In **Customize → Plugins**, turn PR Genie **off and on**. **Canonical MCP is the plugin** (`prgenie`). Do not add a workspace `.cursor/mcp.json` named `prgenie` — Connected MCPs will show two rows (tag Plugin + tag folder, e.g. pr-genie) and Local can stick on Connecting…. Enable **only one** `prgenie` entry.
3. **Sidebar / Local PRs** — that is a **VS Code extension**, not the plugin. `link-plugin` does not update it. Run `pnpm link-extension`, then **quit Cursor fully and reopen** (or F5 `Run PR Genie Extension` for a debug host).

`link-plugin` pins MCP `command` to this machine's `node.exe` and `server.cjs` to the plugin folder (UTF-8, no BOM) so Cursor does not look for `mcp/server.cjs` in the workspace root.

## CLI

```text
prgenie version
prgenie create [--title t] [--body "summary"] [--base main] [--head branch]
prgenie attach <pr-url|pr-number|branch> [--title t] [--body b] [--base ref]
prgenie queue
prgenie inbox
prgenie watch
prgenie claim-review <id> [--head sha] [--source name]
prgenie steward
prgenie steward <id> [--restart] [--implementor-missing] [--implementor-failed] [--json]
prgenie steward bind <id> [--implementor taskId] [--reviewer taskId]
prgenie doctor
prgenie sessions [--limit N] [--hook name] [--since iso] [--json]
prgenie export <id> [--skip-validation] [--verbose]
prgenie shepherd <id> [--verbose]
prgenie update <id> [--title t] [--body "summary"]
prgenie list [--all] [--search q] [--query q] [--in title,body,comment,file]
prgenie show <id>
prgenie diff <id> [--stat] [-- path...]
prgenie delete <id> --yes
prgenie reopen <id>
prgenie approve <id>
prgenie ready <id>
prgenie request-changes <id> -m "..."
prgenie comment <id> -m "..." [--role human|agent|reviewer] [--author name] [--path file] [--line n] [--side left|right] [--reply-to commentId] [--body-file path]
prgenie address <id> <commentId> -m "..."
prgenie resolve <id> <commentId> -m "..."
prgenie edit-comment <id> <commentId> -m "..."
prgenie delete-comment <id> <commentId> [--yes]
prgenie complete-review <id> [-m message] [--force]
prgenie status <id> <draft|ready|changes_requested|reviewed|approved>
prgenie worktrees
prgenie worktree <id>
prgenie learnings [--disabled] [--category name]
prgenie disable-learning <id>
prgenie enable-learning <id>
prgenie delete-learning <id> [--yes]
prgenie preflight <id>
prgenie gh list
prgenie gh status
prgenie gh use <login>
prgenie mcp
```

`prgenie doctor` checks plugin/extension freshness, MCP config (BOM / `${PLUGIN_ROOT}` / duplicate `prgenie` name / pinned `node`), monorepo/VSIX version alignment, export-halt state, corrupt PR files, orphaned `.loops` worktrees, `gh` bind, legacy hooks, and the last shepherd CI failure log (when present). On CI failure, toast/CLI name the check and a short excerpt; `prgenie shepherd <id> --verbose` prints the capped full log under `.git/agent-console/ci-logs/`. Agent orchestration is `/loop` (`prgenie steward` / MCP `steward_next`): one steward per loop, durable Task ids in `.git/agent-console/stewards.json`, export gate before Push to origin. `prgenie watch start|stop|listen` hard-errors and points at `/loop`. `prgenie claim-review` / MCP `claim_review` is the durable one-reviewer-per-HEAD lock.

Bind a GitHub login per repo (`prgenie gh use <login>`). Before `git push` / `gh`, PR Genie switches `gh` to that account. `gh auth` is global — only one account is active at a time — so the bind is how this project stays on `radiancelux` instead of `ccc-radiancelux`.

Works from a Conductor workspace or any other worktree — same repo git dir.

## Storage (git-native)

- `refs/local-pr/<id>/head` and `refs/local-pr/<id>/base`
- Notes on `refs/notes/local-pr`
- Metadata in `.git/agent-console/` (not committed); CI failure logs in `.git/agent-console/ci-logs/`

Cursor may auto-clean worktrees. The loop remains.

## Status

`draft` → `ready` (reviewer may file comments) → `complete_review` → `changes_requested` or `reviewed` → `approved`

Reviewer comments stay on `ready` until **`complete_review`**. That flip is what wakes the implementor (`changes_requested`) or marks **review cleared** (`reviewed`) so the steward can run the export gate. Ready-for-human / Push language only after `handoff_human`. Human comments still request changes immediately. The implementor **addresses** each open finding with a reply under that comment (`address_comment`). Addressing the **last** open finding sets `ready` and posts Review requested so the steward can Task the reviewer again. The reviewer **resolves** addressed comments, then **always** `complete_review`. **`/loop`** drives implement ↔ review via Tasks and only shows Push to origin after the export gate is ready. `/export` opens the GitHub PR at origin and **archives** the loop (`approved`). Archived packets stay on disk (`prgenie show <id>`, `refs/local-pr/*`, Local PRs **Show archived**) but drop off `prgenie list` and MCP `list_local_prs` unless you pass `--all` / `all=true`. Export checks the **main workspace** off the loop branch (onto the loop base) and removes a sibling `../<repo>.loops/<id>` checkout. If this window is still on that extra worktree, PR Genie reopens the primary folder and then clears it. Every loop should have a **summary** (`body`): why, what changed, how to test.

## Roadmap

Gap analysis and prioritized roadmap: [ROADMAP.md](ROADMAP.md).

## License

MIT
