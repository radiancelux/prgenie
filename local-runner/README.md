# PR Genie local CLI runner

Standalone **localhost** orchestrator for the implement → PR → review → fix loop using pluggable **AI CLI drivers** (`cursor-agent` default). This package does **not** replace the Cursor plugin steward or extension; it is for workstation local development and automation via MCP.

See **`docs/drivers.md`** for the driver adapter contract and built-in drivers.

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

`pnpm build` runs Tailwind v4 (`@tailwindcss/cli`) on `local-runner/src/dashboard.css`, writes minified CSS to `local-runner/dist/dashboard.min.css` (gitignored), and embeds it in the single `local-runner/dist/runner.cjs` bundle (no CDN or runtime compiler).

Doc lint findings (docs jobs) are stored on `ciStatus.findings` (cap **250** per poll). When the worktree has no markdownlint config, the runner uses bundled prose-friendly defaults (`local-runner/markdownlint-prose-defaults.jsonc`); repository configs take precedence.

Binary: `pnpm local-runner --help` (or `node local-runner/dist/runner.cjs`).

## Config

| Variable                                             | Purpose                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PRGENIE_RUNNER_TOKEN`                               | **Required.** Bearer token for MCP + `/api/*`                                                         |
| `PRGENIE_RUNNER_HOST`                                | Bind address (default `127.0.0.1`; use `0.0.0.0` for same-LAN phones/tablets)                         |
| `PRGENIE_RUNNER_PORT`                                | HTTP port (default `9473`)                                                                            |
| `PRGENIE_RUNNER_DATA_DIR`                            | Job JSON + logs (default `~/.prgenie/local-runner`)                                                   |
| `PRGENIE_RUNNER_MODEL`                               | Default model (default `composer-2.5`)                                                                |
| `PRGENIE_RUNNER_DRY_RUN`                             | `1` — skip real `cursor-agent` / git worktrees (tests & smoke)                                        |
| `PRGENIE_RUNNER_DEFAULT_REPO_PATH`                   | Optional local path fallback for **code** jobs when Setup has no code default preset                  |
| `PRGENIE_RUNNER_NOTIFY_EMAIL`                        | Resend notification recipient                                                                         |
| `PRGENIE_RUNNER_FROM_EMAIL`                          | Resend sender (default `PR Genie Local Runner <runner@example.com>`; full `Name <addr>` or bare addr) |
| `RESEND_API_KEY` or `PRGENIE_RUNNER_RESEND_KEY_FILE` | Resend API key (never logged)                                                                         |

Worktrees (non-dry-run): `~/.cursor/worktrees/<repo-slug>/<job-id>`.

Worktrees are **not** removed immediately on `approved` — the runner keeps them until draft→ready promotion finishes or **auto-cleanup** runs (merged PR hidden ≥ ~1h, or terminal jobs when branch is merged/clean). Cleanup **skips** dirty or unpushed worktrees (warning on the job). Manual prune:

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
- **Setup:** http://127.0.0.1:9473/setup — default model/driver, notify, driver binaries, **docs repo presets** and default repo per job type (bearer-gated `GET`/`PATCH /api/settings`)
- **MCP HTTP:** `POST http://127.0.0.1:9473/mcp` with `Authorization: Bearer $PRGENIE_RUNNER_TOKEN`
- **MCP stdio:** `pnpm local-runner mcp` (for Cursor `mcp.json`)

### MCP tools

- `start_job` — `repoPath` or `remote`, `branch`, `promptFile` (code jobs), optional **`jobType`** / **`profile`** (`docs` | code), optional **`docsTemplate`** (`marketing` | `policy` | `research`), optional `reviewPromptFile`, `fixPromptFile`, `maxRounds`, `model`, optional **`driver`** (id), `dryRun`, optional `ticketUrl` / `linearIssue` (when omitted, the runner parses `issue-<n>` from the branch name)
- `list_jobs` — optional `includeArchived` (archived jobs carry `archivedAt`)
- `get_job` — status + log tail (also resolves archived jobs, read-only)
- `steer_job` — queue follow-up text for the next agent step
- `stop_job`
- `archive_job` — `id`; removes a finished job from the dashboard (see [Removing jobs](#removing-jobs-archive)). Errors while the job is running.
- `restore_job` — `id`; moves an archived job back. Errors if a live job already uses that id.

### Job stages

`building` → `reviewing` (round N) → `fixing` → … → `approved` | `changes_remaining` | `stuck` | `failed` | `stopped`

Default **`maxRounds`** = 3 (review/fix cycles). N review rounds allow at most N−1 intervening fix passes. Reviewer must post **one** GitHub issue comment on the PR ending with `VERDICT: APPROVE` or `VERDICT: CHANGES` (built-in default review prompt enforces this). The runner also accepts the same `VERDICT:` line on PR review bodies as a fallback.

### Docs mode

Non-technical **docs** jobs worktree a **user-configured** business/policy repo (Setup presets + default for `docs`, or per-job `repoPath` / `remote` override). They use built-in implement/review prompts (`docsTemplate`: marketing, policy, research) and open **draft Markdown PRs**. GitHub Actions CI is **not** waited on; optional **doc checks** (markdown lint on changed `.md`) show as **Doc checks** on the dashboard. Draft→ready still requires **`VERDICT: APPROVE`** on the current HEAD and doc checks green (or N/A when disabled). No auto-merge.

Configure research/web in Cursor CLI: [`autoAcceptWebSearch`](https://cursor.com/docs/cli/changelog), WebFetch [`permissions.allow`](https://cursor.com/docs/cli/reference/permissions), headless [`--force`](https://cursor.com/docs/cli/using). Configure docs repo presets on the Setup screen (org/repo slug only in settings — never hardcode private paths in prompts).

MCP callers share the runner host owner's compute, Cursor login, and `gh` identity unless they run a separate runner + token.

### Dashboard (localhost UI)

Default implement prompt requires **`gh pr create --draft`**. After **`VERDICT: APPROVE`** on the current HEAD and **green CI** for that same HEAD, the runner runs **`gh pr ready`** once (stays draft if CI is pending/failed or head moves). Dashboard shows **Draft** vs **Ready** from GitHub `isDraft`. No auto-merge.

The jobs table shows **Ticket** (issue id), **PR**, **Ready** (draft/ready), **Status** (CI), **Model**, **Tokens** (summed from cursor-agent `stream-json` usage in the job log), and **Updated**. On narrow screens (~390px) rows become cards. The job detail view shows a **Cursor-style agent transcript** (stream-json), optional raw log toggle, and a **Steer** box that queues follow-up text via the same bearer-protected API as MCP `steer_job`. **Email notifications** and runner defaults live on the **Setup** screen; settings persist in `$PRGENIE_RUNNER_DATA_DIR/settings.json` (legacy `notify-settings.json` migrates on first load). The Resend API key is never shown in the UI — only `RESEND_API_KEY` / `PRGENIE_RUNNER_RESEND_KEY_FILE` on the server. When the dashboard recipient is empty, notify email falls back to `PRGENIE_RUNNER_NOTIFY_EMAIL`. While a job has a PR, the runner polls CI on a modest interval during active stages and until checks settle on terminal jobs. It uses GitHub **`gh pr view --json statusCheckRollup`** first; when that is unavailable it falls back to **`origin pr checks`** when the Origin CLI can read the PR. The CI badge includes the source (`github` or `origin`).

Authenticated API: `GET` / `PATCH /api/settings`, `GET` / `PUT /api/notify-settings` (legacy) with bearer token (same as other `/api/*` routes).

### Removing jobs (archive)

Finished jobs (`failed`, `stuck`, `stopped`, `approved`, `changes_remaining`) show a **Remove** button on the row, the mobile card, and the inline detail panel. Running jobs (`building`, `reviewing`, `fixing`) never do, and the server rejects them too. **Clear failed** removes every `failed` job, and with **Include stuck & stopped** checked it also removes `stuck` and `stopped` jobs. Both actions ask for confirmation first, using the browser's native `confirm()` so it works with touch and keyboard. **Show archived** lists archived jobs with a **Restore** button.

Archiving moves files within the data dir:

```text
$PRGENIE_RUNNER_DATA_DIR/
  jobs/<id>.json            live jobs
  logs/<id>.log
  archived/jobs/<id>.json   archived jobs (archivedAt set)
  archived/logs/<id>.log
```

Restore moves both files back and clears `archivedAt`. It refuses (`409`) if a live job already uses the id. Job ids must match `[A-Za-z0-9_-]` before any file is touched.

Worktrees: archiving removes the job's git worktree only when it is **clean and pushed**, so the branch is free for a new job. A worktree with uncommitted changes or unpushed commits is **kept** and never force-removed. The response then includes a `warning` (shown on the dashboard) with the path to clean up by hand.

| Route                             | Body                               | Result                                                                                       |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/jobs/:id/archive`      | —                                  | `200 { ok, id, archivedAt, worktree: "removed" \| "kept" \| "none", warning? }`              |
|                                   |                                    | `409` while running (`{ error, stage }`), `404` unknown id, `400` invalid id                 |
| `POST /api/jobs/:id/restore`      | —                                  | `200 { ok, id, stage }`; `409` on id collision, `404` not archived                           |
| `POST /api/jobs/clear-failed`     | `{ "includeStuckStopped"?: bool }` | `200 { ok, stages, archived: [ids], warnings: [{ id, warning }], skipped: [{ id, error }] }` |
| `GET /api/jobs?includeArchived=1` | —                                  | Live jobs plus archived ones                                                                 |
| `GET /api/jobs/meta`              | —                                  | `{ totalOnDisk, mergedHidden, archived }`                                                    |
| `GET /api/events?token=…`         | —                                  | SSE: `data: {"type":"jobs"}` whenever a job is started, archived, or restored                |

The dashboard subscribes to `/api/events`, so other open dashboards drop or re-add rows without a reload. The 8s poll still covers changes made through a separate `mcp` stdio process.

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

## local development / smoke (no CI)

Dry-run loop without network email or real agents:

```bash
export PRGENIE_RUNNER_TOKEN=smoke
pnpm build
node local-runner/scripts/smoke-dry-run.mjs
```

Real local development: use a ticket prompt file, local `repoPath`, valid `gh auth`, and Resend env vars; watch the UI stage and PR link.

## Resend

Emails send when notify is **enabled** in the dashboard (or persisted settings), a recipient is set (dashboard or `PRGENIE_RUNNER_NOTIFY_EMAIL`), Resend is configured, and (1) a PR is detected after implementor and (2) the loop ends (`approved` or `changes_remaining`). Integration tests mock HTTP; unit tests live in `src/resend.test.ts`.

## Persistence

Jobs are JSON under `$PRGENIE_RUNNER_DATA_DIR/jobs/` (archived ones under `archived/jobs/`, see [Removing jobs](#removing-jobs-archive)). Runner settings (notify, defaults, drivers, reserved `jobTypes` / `presets` bags) live in `$PRGENIE_RUNNER_DATA_DIR/settings.json`. Restarting `serve` reloads active jobs (`building`, `reviewing`, `fixing`) and continues the loop.
