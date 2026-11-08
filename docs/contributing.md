# Contributing and maintainer setup

New users should start with the [root README](../README.md) happy path. This page is for **monorepo development**: the Cursor plugin, VS Code/Cursor extension, and `packages/cli` — not the published npm runner alone.

## Prerequisites

- **Node.js 22+** (`.nvmrc`, `engines` in root `package.json`; `engine-strict=true` in `.npmrc`)
- **pnpm 10+**, **git**, **GitHub CLI (`gh`)**, **Cursor** when working on editor integration

## First-time setup

```powershell
pnpm install
pnpm build
pnpm test
pnpm link-plugin
pnpm link-extension
```

Generated MCP/hook bundles (`packages/plugin/mcp/server.cjs`, `packages/plugin/hooks/*.cjs`) are **not** committed — `pnpm build` (and `pnpm link-plugin`, which runs build first) produce them.

Stranger path after clone: **pull → `pnpm install` → `pnpm build` → `pnpm link-plugin` → Customize → Plugins → PR Genie off/on.** The plugin MCP will not start until those bundles exist on disk.

**Huge ±tens-of-thousands-line diffs** on `server.cjs` / hook `.cjs` mean a dirty local build against an old tracked file, or you are on a **pre-migration** branch from before those outputs were gitignored. Rebuild (`pnpm build`) or rebase onto current `main`; do not treat that churn as product source.

### Plugin refresh

1. **CLI** — Prefer `pnpm cli --help` or an **absolute** path: `node <repo>\packages\cli\dist\prgenie.cjs list`. On Windows, `prgenie` is **not** on PATH after `link-plugin` (plugin MCP is pinned; the CLI is not globally linked). Do not assume a bare `prgenie` works in Task shells.
2. **Cursor Plugin** (rules, `/local-pr`, MCP) — `link-plugin` copies to `%USERPROFILE%\.cursor\plugins\local\prgenie`. A reload often **does not** refresh the MCP tool list. In **Customize → Plugins**, turn PR Genie **off and on**. **Canonical MCP is the plugin** (`prgenie`). Do not add a workspace `.cursor/mcp.json` named `prgenie` — Connected MCPs will show two rows (tag Plugin + tag folder) and Local can stick on Connecting…. Enable **only one** `prgenie` entry.
3. **Sidebar / Local PRs** — VS Code extension, not the plugin. `link-plugin` does not update it. Run `pnpm link-extension`, then **quit Cursor fully and reopen** (or F5 **Run PR Genie Extension** for a debug host).

`link-plugin` runs `pnpm build`, then pins MCP `command` to this machine's `node.exe` and `server.cjs` to the plugin folder (UTF-8, no BOM) so Cursor does not look for `mcp/server.cjs` in the workspace root. It also pins `timeout: 4200` (seconds) for git+CI MCP tools.

**Parallel Tasks:** keep at most **2** concurrent implementor Tasks as a soft default.

## Checks

See [CONTRIBUTING.md](../CONTRIBUTING.md) for CI commands (`pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm check-versions`).

## Monorepo CLI reference

These commands are **`packages/cli`** (`pnpm cli …` or `node packages/cli/dist/prgenie.cjs`). They are **not** on the npm `prgenie` package (runner: `init`, `doctor`, `mcp`, `serve`, `config`).

```text
prgenie create [--title t] [--body "summary"] [--base main] [--head branch]
prgenie attach <pr-url|branch>
prgenie list [--all] [--search q]
prgenie show <id> | diff <id> | approve <id> | export <id>
prgenie steward <id> [--restart] [--json]
prgenie shepherd <id> [--verbose]
prgenie doctor | mcp [--smoke]
prgenie gh use <login>
```

`prgenie watch start|stop|listen`, `queue`, and `inbox` **hard-error** — use `/steward`. `prgenie doctor` checks plugin/extension freshness, MCP config, `gh` bind, and version alignment (see [Troubleshooting](troubleshooting.md)).

Subagent capture on `subagentStop` is **opt-in**: `PRGENIE_CAPTURE_SUBAGENT=1`.

## Storage (git-native)

- `refs/local-pr/<id>/head` and `refs/local-pr/<id>/base`
- Notes on `refs/notes/local-pr`
- Metadata in `.git/agent-console/` (not committed)

## npm runner development

Source: `local-runner/`. After changes: `pnpm build` (copies bundle to `packages/npm-prgenie/runner.cjs`). Run `pnpm local-runner doctor` or `node local-runner/dist/runner.cjs`.

## See also

- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [Release](release.md)
- [Plugin README](../packages/plugin/README.md)
