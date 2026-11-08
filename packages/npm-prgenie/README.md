# prgenie (npm)

Local **implement → PR → review → fix** runner for agent workstations. Install once, wire your MCP client to **stdio** (`npx -y prgenie mcp`), and start jobs without running a long-lived HTTP server or bearer token.

Optional: `prgenie serve` for a browser dashboard and HTTP MCP (localhost + token).

Requires **Node.js 22+**, **git**, **GitHub CLI (`gh`)**, and **`cursor-agent`** for real (non–dry-run) jobs.

## Install (recommended: system-level)

The runner is a per-machine tool, so register it once for every repo rather than per project:

- **`npx` (recommended, no install):** every snippet below runs `npx -y prgenie mcp`. npm caches the package after the first launch.
- **Global install (recommended on slow/offline networks):** `npm install -g prgenie` (or pin `prgenie@0.1.3`), then use `"command": "prgenie", "args": ["mcp"]` in MCP config. Upgrade with `npm install -g prgenie@latest`.
- **Why global?** On a flaky DNS cache, `npx -y prgenie mcp` can take well over a minute to fail, and many MCP hosts time out first. Global install also helps GUI apps that do not inherit your shell `PATH` (see [Troubleshooting](#troubleshooting)).

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

Print the same snippet: `npx -y prgenie config --client cursor` (add `--global` after `npm install -g prgenie`, or omit `--npx` when the `prgenie` binary is on PATH)

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

Config file locations (create `mcpServers` if missing):

| OS      | Path                                                              |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |

After editing, **fully quit and restart Claude Desktop** (not just closing the window).

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

With a global install, use `"command": "prgenie", "args": ["mcp"]` instead of `npx`.

Print the snippet: `npx -y prgenie config --client claude-desktop` (`--global` when using `npm install -g prgenie`).

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
npx -y prgenie init   # once — creates ~/.prgenie/local-runner/runner.token
npx -y prgenie serve  # reads runner.token automatically (no export required)
```

Open `http://127.0.0.1:9473/` (default). Paste the token from `runner.token` into the dashboard (serve prints the path on startup). MCP over HTTP: `POST /mcp` with `Authorization: Bearer` from that file. Optional override: `export PRGENIE_RUNNER_TOKEN="$(cat ~/.prgenie/local-runner/runner.token)"`.

## Email notifications (Resend)

Optional notify emails fire when a job opens/updates a PR and when the loop finishes (`approved` / `changes_remaining`). Configure **on the machine that runs `prgenie serve`** (stdio-only MCP uses the same env if you also run `serve`).

| Variable                                             | Purpose                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY` or `PRGENIE_RUNNER_RESEND_KEY_FILE` | Resend API key (never logged or shown in the UI)                                                                          |
| `PRGENIE_RUNNER_FROM_EMAIL`                          | Sender address — default `PR Genie Local Runner <runner@example.com>`. Use a **verified domain** in Resend or sends fail. |
| `PRGENIE_RUNNER_NOTIFY_EMAIL`                        | Default recipient when notify is enabled in the dashboard/Setup                                                           |

`serve` reads these env vars **at startup** — set them, then restart `prgenie serve`. The dashboard and Setup show env names when Resend is missing; saving notify preferences while Resend is unconfigured stores settings but warns that mail cannot send yet.

## Windows notes

- **`prgenie init`** prints a PowerShell line for `PRGENIE_RUNNER_TOKEN` on Windows as well as bash `export`.
- MCP config paths: Cursor `%USERPROFILE%\.cursor\mcp.json`; Claude Desktop `%APPDATA%\Claude\claude_desktop_config.json`; VS Code project `.vscode\mcp.json`.
- Some MCP hosts need `"command": "npx.cmd"` or a full path to `npx` / `prgenie` — prefer **`npm install -g prgenie`** and `"command": "prgenie"` when `spawn npx ENOENT` appears in host logs.

## Two different `prgenie` CLIs?

The **npm package** (this README) is the runner. **`prgenie list` / `create` / `export`** belong to the [monorepo plugin CLI](https://github.com/radiancelux/prgenie#which-prgenie-do-i-need) — not this binary. The runner prints a hint if you run those command names.

## Troubleshooting

| Symptom                             | What to do                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`spawn npx ENOENT` (MCP host)**   | GUI apps often lack shell PATH. Use `npm install -g prgenie`, then `"command": "prgenie", "args": ["mcp"]`, or set `command` to the absolute path from `which npx` / `where npx`. Restart the MCP host. |
| **`gh` not authenticated**          | Run `gh auth login`; re-run `prgenie doctor`. Jobs need `gh` for PR/CI.                                                                                                                                 |
| **`cursor-agent` missing**          | Install Cursor CLI; or pick another driver in `settings` after `serve`.                                                                                                                                 |
| **Branch held by another worktree** | Another job or git worktree uses that branch. Stop/archive the other job or pick a new branch.                                                                                                          |
| **Model unavailable on your plan**  | Override `model` in `start_job` or set defaults via `settings` / Setup UI.                                                                                                                              |
| **Job stuck (watchdog)**            | Check dashboard logs; `stop_job`, then `archive_job`. Tune watchdog via `settings` or Setup.                                                                                                            |
| **Notify saved but no email**       | Confirm `RESEND_API_KEY` + verified `PRGENIE_RUNNER_FROM_EMAIL`, restart `serve`, recipient set.                                                                                                        |

## Environment

| Variable                                            | Purpose                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `PRGENIE_RUNNER_DATA_DIR`                           | Job store (default `~/.prgenie/local-runner`)                   |
| `PRGENIE_RUNNER_TOKEN`                              | Bearer for **`serve` only** (or use `runner.token` from `init`) |
| `PRGENIE_RUNNER_DRY_RUN`                            | `1` — default new jobs (MCP + dashboard) to dry run             |
| `PRGENIE_RUNNER_HOST` / `PRGENIE_RUNNER_PORT`       | HTTP bind (default `127.0.0.1:9473`)                            |
| `PRGENIE_RUNNER_MODEL`                              | Default agent model (default `composer-2.5`)                    |
| `PRGENIE_RUNNER_DEFAULT_REPO_PATH`                  | Fallback repo path for code jobs when Setup has no default      |
| `RESEND_API_KEY` / `PRGENIE_RUNNER_RESEND_KEY_FILE` | Resend API key (notify; server-side only)                       |
| `PRGENIE_RUNNER_FROM_EMAIL`                         | Resend sender (must be verified in Resend)                      |
| `PRGENIE_RUNNER_NOTIFY_EMAIL`                       | Default notify recipient                                        |

## Monorepo development

Source lives under `local-runner/` in [github.com/radiancelux/prgenie](https://github.com/radiancelux/prgenie). From the repo root: `pnpm build && pnpm local-runner mcp`.

## License

MIT — see [`LICENSE`](LICENSE) (shipped in the npm package).
