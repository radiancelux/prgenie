# PR Genie local CLI runner (RAD-315)

Standalone **localhost** orchestrator for the implement → PR → review → fix loop using `cursor-agent`. This package does **not** replace the Cursor plugin steward or extension; it is for workstation dogfood and automation via MCP.

Linear: [RAD-315](https://linear.app/radiancelux/issue/RAD-315/local-cli-runner-cursor-agent-implementreview-loop-mcp-ui-resend)

## Batch G lessons (cursor-agent)

| Topic       | Behavior                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shell       | **`cursor-agent -p --force --trust`** — without `--force`, nested shell is blocked                                          |
| Text output | **`--output-format text`** — output appears **only at process exit** (not live)                                             |
| Live logs   | This runner uses **`--output-format stream-json`** for agent steps so the UI SSE tail updates during runs                   |
| No-PR guard | If the implementor finishes without a GitHub PR on the branch, the job becomes **`stuck`** (no review of a local-only diff) |

Every subprocess the runner spawns uses:

```bash
cursor-agent -p --force --trust --model "${MODEL:-composer-2.5}" --output-format stream-json
```

## Install

From the monorepo root:

```bash
pnpm install
pnpm build
```

Binary: `pnpm local-runner --help` (or `node local-runner/dist/runner.cjs`).

## Config

| Variable                                             | Purpose                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PRGENIE_RUNNER_TOKEN`                               | **Required.** Bearer token for MCP + `/api/*`                                                              |
| `PRGENIE_RUNNER_HOST`                                | Bind address (default `127.0.0.1`; use `0.0.0.0` for same-LAN phones/tablets)                              |
| `PRGENIE_RUNNER_PORT`                                | HTTP port (default `9473`)                                                                                 |
| `PRGENIE_RUNNER_DATA_DIR`                            | Job JSON + logs (default `~/.prgenie/local-runner`)                                                        |
| `PRGENIE_RUNNER_MODEL`                               | Default model (default `composer-2.5`)                                                                     |
| `PRGENIE_RUNNER_DRY_RUN`                             | `1` — skip real `cursor-agent` / git worktrees (tests & smoke)                                             |
| `PRGENIE_RUNNER_NOTIFY_EMAIL`                        | Resend notification recipient                                                                              |
| `PRGENIE_RUNNER_FROM_EMAIL`                          | Resend sender (default `PR Genie Local Runner <runner@radiancelux.tech>`; full `Name <addr>` or bare addr) |
| `RESEND_API_KEY` or `PRGENIE_RUNNER_RESEND_KEY_FILE` | Resend API key (never logged)                                                                              |

Worktrees (non-dry-run): `~/.cursor/worktrees/<repo-slug>/<job-id>`.

On **`approved`**, the worktree is removed. On **`failed`**, **`stuck`**, or **`changes_remaining`**, it is kept for debugging. Prune:

```bash
pnpm local-runner prune-worktrees
```

## Start MCP + UI

```bash
export PRGENIE_RUNNER_TOKEN='your-local-secret'
pnpm local-runner serve
```

Default bind is **localhost only** (`127.0.0.1`). To open the dashboard from another device on your Wi‑Fi/LAN:

```bash
export PRGENIE_RUNNER_HOST=0.0.0.0
export PRGENIE_RUNNER_TOKEN='your-local-secret'   # keep this secret — same bearer protects UI, SSE, and MCP
pnpm local-runner serve
```

On startup the runner prints reachable URLs (loopback plus a best-effort LAN IP when bound to `0.0.0.0`). Allow the chosen TCP port through your host firewall if needed. Do **not** expose the runner to the public internet without TLS and a proper reverse proxy (out of scope here).

- **UI:** http://127.0.0.1:9473/ (paste token once; stored in `localStorage`)
- **MCP HTTP:** `POST http://127.0.0.1:9473/mcp` with `Authorization: Bearer $PRGENIE_RUNNER_TOKEN`
- **MCP stdio:** `pnpm local-runner mcp` (for Cursor `mcp.json`)

### MCP tools

- `start_job` — `repoPath` or `remote`, `branch`, `promptFile`, optional `reviewPromptFile`, `fixPromptFile`, `maxRounds`, `model`, `dryRun`, optional `ticketUrl` / `linearIssue` (when omitted, the runner parses `RAD-<n>` from the branch name and links Linear)
- `list_jobs`
- `get_job` — status + log tail
- `steer_job` — queue follow-up text for the next agent step
- `stop_job`

### Job stages

`building` → `reviewing` (round N) → `fixing` → … → `approved` | `changes_remaining` | `stuck` | `failed` | `stopped`

Default **`maxRounds`** = 2 (review/fix cycles). Reviewer must post **one** GitHub issue comment on the PR ending with `VERDICT: APPROVE` or `VERDICT: CHANGES` (built-in default review prompt enforces this). The runner also accepts the same `VERDICT:` line on PR review bodies as a fallback.

### Dashboard (localhost UI)

The jobs table shows **Ticket** (Linear), **PR**, **Status** (CI), **Model**, **Tokens** (summed from cursor-agent `stream-json` usage in the job log), and **Updated**. On narrow screens (~390px) rows become cards. The job detail view shows a **Cursor-style agent transcript** (stream-json), optional raw log toggle, and a **Steer** box that queues follow-up text via the same bearer-protected API as MCP `steer_job`. While a job has a PR, the runner polls CI on a modest interval during active stages and until checks settle on terminal jobs. It prefers **`origin pr checks`** when the Origin CLI is authenticated; otherwise it falls back to GitHub **`gh pr view --json statusCheckRollup`**. The CI badge includes the source (`origin` or `github`).

## Example job

```bash
export PRGENIE_RUNNER_TOKEN=dev
export PRGENIE_RUNNER_NOTIFY_EMAIL=you@example.com
export RESEND_API_KEY=re_...

pnpm local-runner serve
```

MCP `start_job`:

```json
{
  "repoPath": "/path/to/radiancelux/prgenie",
  "branch": "feat/my-ticket",
  "promptFile": "/path/to/implementor-prompt.md",
  "maxRounds": 2
}
```

## Dogfood / smoke (no CI)

Dry-run loop without network email or real agents:

```bash
export PRGENIE_RUNNER_TOKEN=smoke
pnpm build
node local-runner/scripts/smoke-dry-run.mjs
```

Real dogfood: use a ticket prompt file, local `repoPath`, valid `gh auth`, and Resend env vars; watch the UI stage and PR link.

## Resend

Emails send when (1) a PR is detected after implementor and (2) the loop ends (`approved` or `changes_remaining`). Integration tests mock HTTP; unit tests live in `src/resend.test.ts`.

## Persistence

Jobs are JSON under `$PRGENIE_RUNNER_DATA_DIR/jobs/`. Restarting `serve` reloads active jobs (`building`, `reviewing`, `fixing`) and continues the loop.
