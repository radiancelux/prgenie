# prgenie (npm)

Local **implement → PR → review → fix** runner for agent workstations. Install once, wire your MCP client to **stdio** (`npx -y prgenie mcp`), and start jobs without running a long-lived HTTP server or bearer token.

Optional: `prgenie serve` for a browser dashboard and HTTP MCP (localhost + token).

Requires **Node.js 22+**, **git**, **GitHub CLI (`gh`)**, and **`cursor-agent`** for real (non–dry-run) jobs.

## Install (recommended: system-level)

The runner is a per-machine tool, so register it once for every repo rather than per project:

- **`npx` (recommended, no install):** every snippet below runs `npx -y prgenie mcp`. npm caches the package after the first launch.
- **Global install (pin a version):** `npm install -g prgenie` (or `npm install -g prgenie@0.1.2`), then use `"command": "prgenie", "args": ["mcp"]` in place of `npx -y prgenie mcp`. Upgrade with `npm install -g prgenie@latest`.

A repo-local devDependency also works but is optional; see [Optional: project devDependency](#optional-project-devdependency).

## Quick start — MCP client config

All snippets use the published CLI. No token is required for stdio. The server id `prgenie-runner` keeps this separate from the Cursor plugin's `prgenie` steward MCP.

### Cursor (`.cursor/mcp.json` in your repo or user config)

```json
{
  "mcpServers": {
    "prgenie-runner": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "prgenie", "mcp"]
    }
  }
}
```

Use a **different server id** than the Cursor plugin’s `prgenie` steward MCP (e.g. `prgenie-runner` above) so both can coexist.

Print the same snippet: `npx -y prgenie config --client cursor`

### Claude Code (`claude mcp add`)

Register the stdio server for all your projects (verified with Claude Code 2.1):

```bash
claude mcp add --scope user prgenie-runner -- npx -y prgenie mcp
claude mcp list
# prgenie-runner: npx -y prgenie mcp - ✔ Connected
```

- Everything after `--` is the server command, so Claude Code does not parse `-y` as its own flag.
- `--scope user` makes it available in every project (stored in `~/.claude.json`). `--scope project` writes a shareable `.mcp.json` in the repo root instead; the default `--scope local` applies to the current project only.
- With a global install: `claude mcp add --scope user prgenie-runner -- prgenie mcp`.
- Make every job a dry-run while you try it out: `claude mcp add --scope user prgenie-runner -e PRGENIE_RUNNER_DRY_RUN=1 -- npx -y prgenie mcp` (keep the server name before `-e`).
- Check it with `claude mcp get prgenie-runner`; remove it with `claude mcp remove prgenie-runner -s user`.

Print the same command: `npx -y prgenie config --client claude-code`

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "prgenie-runner": {
      "command": "npx",
      "args": ["-y", "prgenie", "mcp"]
    }
  }
}
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "prgenie-runner": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "prgenie", "mcp"]
    }
  }
}
```

Print the same snippet: `npx -y prgenie config --client vscode`

### Generic stdio client

```json
{
  "mcpServers": {
    "prgenie-runner": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "prgenie", "mcp"]
    }
  }
}
```

### Optional: project devDependency

**Optional — not the recommended setup.** Use this only when a repo must pin its own runner version. Prefer the system-level `npx` or global install above: MCP clients launch servers from their own working directory, and the runner's job store (`~/.prgenie/local-runner`) is per machine anyway.

```bash
pnpm add -D prgenie   # or: npm install -D prgenie / yarn add -D prgenie
pnpm exec prgenie mcp
```

Point the client at the repo-local binary, for example `"command": "pnpm", "args": ["exec", "prgenie", "mcp"]` in a project-scoped `.cursor/mcp.json`, or `claude mcp add --scope project prgenie-runner -- pnpm exec prgenie mcp`.

## First job walkthrough

1. **Initialize data dir + token (for `serve` later)**

   ```bash
   npx -y prgenie init
   ```

   Creates `~/.prgenie/local-runner` (override with `PRGENIE_RUNNER_DATA_DIR`) and `runner.token` for HTTP mode.

2. **Check prerequisites**

   ```bash
   npx -y prgenie doctor
   ```

   Verifies Node, git, `gh auth`, and `cursor-agent` on PATH.

3. **Dry-run job over MCP** (no real agent; safe smoke test)

   In your MCP client, call tool `start_job` with:

   ```json
   {
     "branch": "chore/runner-smoke",
     "promptFile": "README.md",
     "repoPath": "/path/to/your/git/repo",
     "dryRun": true,
     "maxRounds": 1
   }
   ```

   Dry runs **always** require a real `repoPath` that exists and is a git checkout — that is the only check that blocks a dry run. They **do not** create a worktree or call `cursor-agent`. The other preflight checks a real job runs (driver on PATH, GitHub `origin` remote, `gh` installed and logged in) **never block** a dry run: any gaps are recorded as `preflightWarnings` on the job and the loop still completes. There is no fake GitHub PR link — the dashboard shows **Dry run** / **Simulated** instead of a PR URL.

   Then `get_job` with the returned `id` (check `preflightWarnings` and `dryRun: true`).

4. **Real job on a test branch**

   Same as above with `dryRun: false` (or omit it), a real `repoPath` / `remote`, and `cursor-agent` available. Use a throwaway branch name.

## MCP tools

| Tool                          | Purpose                           |
| ----------------------------- | --------------------------------- |
| `start_job`                   | Start the loop                    |
| `get_job`                     | Status + log tail                 |
| `list_jobs`                   | Dashboard list                    |
| `steer_job`                   | Queue follow-up prompt            |
| `stop_job`                    | Stop running job                  |
| `archive_job` / `restore_job` | Remove / restore finished jobs    |
| `continue_job`                | Extra fix→review round(s)         |
| `restart_runner`              | Graceful restart adoption preview |
| `settings`                    | Read or patch runner settings     |

Stdio and `serve` share one on-disk job store (file lock when both run).

## Optional HTTP dashboard

```bash
export PRGENIE_RUNNER_TOKEN="$(cat ~/.prgenie/local-runner/runner.token)"
npx -y prgenie serve
```

Open `http://127.0.0.1:9473/` (default). MCP over HTTP: `POST /mcp` with `Authorization: Bearer $PRGENIE_RUNNER_TOKEN`.

## Troubleshooting

| Symptom                             | What to do                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| **`gh` not authenticated**          | Run `gh auth login`; re-run `prgenie doctor`. Jobs need `gh` for PR/CI.                        |
| **`cursor-agent` missing**          | Install Cursor CLI; or pick another driver in `settings` after `serve`.                        |
| **Branch held by another worktree** | Another job or git worktree uses that branch. Stop/archive the other job or pick a new branch. |
| **Model unavailable on your plan**  | Override `model` in `start_job` or set defaults via `settings` / Setup UI.                     |
| **Job stuck (watchdog)**            | Check dashboard logs; `stop_job`, then `archive_job`. Tune watchdog via `settings` or Setup.   |

## Environment

| Variable                                      | Purpose                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `PRGENIE_RUNNER_DATA_DIR`                     | Job store (default `~/.prgenie/local-runner`)                   |
| `PRGENIE_RUNNER_TOKEN`                        | Bearer for **`serve` only** (or use `runner.token` from `init`) |
| `PRGENIE_RUNNER_DRY_RUN`                      | `1` — default new jobs (MCP + dashboard) to dry run             |
| `PRGENIE_RUNNER_HOST` / `PRGENIE_RUNNER_PORT` | HTTP bind (default `127.0.0.1:9473`)                            |

## Monorepo development

Source lives under `local-runner/` in [github.com/radiancelux/prgenie](https://github.com/radiancelux/prgenie). From the repo root: `pnpm build && pnpm local-runner mcp`.

## License

MIT — see [`LICENSE`](LICENSE) (shipped in the npm package).
