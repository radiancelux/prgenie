# prgenie (npm)

Local **implement → PR → review → fix** runner for agent workstations. Install once, wire your MCP client to **stdio** (`npx -y prgenie mcp`), and start jobs without running a long-lived HTTP server or bearer token.

Optional: `prgenie serve` for a browser dashboard and HTTP MCP (localhost + token).

Requires **Node.js 22+**, **git**, **GitHub CLI (`gh`)**, and **`cursor-agent`** for real (non–dry-run) jobs.

## Quick start — MCP client config

All snippets use the published CLI. No token is required for stdio.

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

### Project devDependency (pnpm / npm / yarn)

```bash
pnpm add -D prgenie
pnpm exec prgenie mcp
```

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

   Then `get_job` with the returned `id`.

4. **Real job on a test branch**

   Same as above with `dryRun: false` (or omit it), a real `repoPath` / `remote`, and `cursor-agent` available. Use a throwaway branch name.

## MCP tools

| Tool                          | Purpose                        |
| ----------------------------- | ------------------------------ |
| `start_job`                   | Start the loop                 |
| `get_job`                     | Status + log tail              |
| `list_jobs`                   | Dashboard list                 |
| `steer_job`                   | Queue follow-up prompt         |
| `stop_job`                    | Stop running job               |
| `archive_job` / `restore_job` | Remove / restore finished jobs |
| `settings`                    | Read or patch runner settings  |

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
| `PRGENIE_RUNNER_DRY_RUN`                      | `1` — global dry-run default                                    |
| `PRGENIE_RUNNER_HOST` / `PRGENIE_RUNNER_PORT` | HTTP bind (default `127.0.0.1:9473`)                            |

## Monorepo development

Source lives under `local-runner/` in [github.com/radiancelux/prgenie](https://github.com/radiancelux/prgenie). From the repo root: `pnpm build && pnpm local-runner mcp`.

## License

MIT — see repository `LICENSE`.
