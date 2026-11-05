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

| Variable                                             | Purpose                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `PRGENIE_RUNNER_TOKEN`                               | **Required.** Bearer token for MCP + `/api/*`                  |
| `PRGENIE_RUNNER_PORT`                                | HTTP port (default `9473`)                                     |
| `PRGENIE_RUNNER_DATA_DIR`                            | Job JSON + logs (default `~/.prgenie/local-runner`)            |
| `PRGENIE_RUNNER_MODEL`                               | Default model (default `composer-2.5`)                         |
| `PRGENIE_RUNNER_DRY_RUN`                             | `1` — skip real `cursor-agent` / git worktrees (tests & smoke) |
| `PRGENIE_RUNNER_NOTIFY_EMAIL`                        | Resend notification recipient                                  |
| `RESEND_API_KEY` or `PRGENIE_RUNNER_RESEND_KEY_FILE` | Resend API key (never logged)                                  |

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

- **UI:** http://127.0.0.1:9473/ (paste token once; stored in `localStorage`)
- **MCP HTTP:** `POST http://127.0.0.1:9473/mcp` with `Authorization: Bearer $PRGENIE_RUNNER_TOKEN`
- **MCP stdio:** `pnpm local-runner mcp` (for Cursor `mcp.json`)

### MCP tools

- `start_job` — `repoPath` or `remote`, `branch`, `promptFile`, optional `reviewPromptFile`, `fixPromptFile`, `maxRounds`, `model`, `dryRun`
- `list_jobs`
- `get_job` — status + log tail
- `steer_job` — queue follow-up text for the next agent step
- `stop_job`

### Job stages

`building` → `reviewing` (round N) → `fixing` → … → `approved` | `changes_remaining` | `stuck` | `failed` | `stopped`

Default **`maxRounds`** = 2 (review/fix cycles). Reviewer must post **one** PR comment ending with `VERDICT: APPROVE` or `VERDICT: CHANGES` (built-in default review prompt enforces this).

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
