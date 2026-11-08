# PR Genie local CLI runner

Standalone **localhost** orchestrator for the implement → PR → review → fix loop using pluggable **AI CLI drivers** (`cursor-agent` default). This package does **not** replace the Cursor plugin steward or extension; it is for workstation local development and automation via MCP.

**End users:** install the published npm package — see [packages/npm-prgenie/README.md](../packages/npm-prgenie/README.md) (`npx -y prgenie mcp`). This folder is the development source; `pnpm build` copies the bundle into `packages/npm-prgenie` for `npm pack`.

See **`docs/drivers.md`** for the driver adapter contract and built-in drivers.

## Batch G lessons (cursor-agent)

| Topic       | Behavior                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell       | **`cursor-agent -p --force --trust`** — without `--force`, nested shell is blocked                                                                                        |
| Text output | **`--output-format text`** — output appears **only at process exit** (not live)                                                                                           |
| Live logs   | This runner uses **`--output-format stream-json`** for agent steps so the UI SSE tail updates during runs                                                                 |
| No-PR guard | Default: no GitHub PR after build → **`stuck`**. Pass **`expectPr: false`** on `start_job` for issues-only jobs (audit, no code) to finish **`approved`** without review. |

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

| Variable                                             | Purpose                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PRGENIE_RUNNER_TOKEN`                               | **Required for `serve` only** (HTTP UI + bearer MCP). Stdio `mcp` needs no token. `prgenie init` writes `runner.token`. |
| `PRGENIE_RUNNER_HOST`                                | Bind address (default `127.0.0.1`; use `0.0.0.0` for same-LAN phones/tablets)                                           |
| `PRGENIE_RUNNER_PORT`                                | HTTP port (default `9473`)                                                                                              |
| `PRGENIE_RUNNER_DATA_DIR`                            | Job JSON + logs (default `~/.prgenie/local-runner`)                                                                     |
| `PRGENIE_RUNNER_MODEL`                               | Default model (default `composer-2.5`)                                                                                  |
| `PRGENIE_RUNNER_DRY_RUN`                             | `1` — skip real `cursor-agent` / git worktrees (tests & smoke)                                                          |
| `PRGENIE_RUNNER_DEFAULT_REPO_PATH`                   | Optional local path fallback for **code** jobs when Setup has no code default preset                                    |
| `PRGENIE_RUNNER_NOTIFY_EMAIL`                        | Resend notification recipient                                                                                           |
| `PRGENIE_RUNNER_FROM_EMAIL`                          | Resend sender (default `PR Genie Local Runner <runner@example.com>`; full `Name <addr>` or bare addr)                   |
| `RESEND_API_KEY` or `PRGENIE_RUNNER_RESEND_KEY_FILE` | Resend API key (never logged)                                                                                           |

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
- **Setup:** http://127.0.0.1:9473/setup — default model/driver, **`defaultMaxRounds`**, **`maxActiveJobs`**, per-stage **build/review/fix** models, **watchdog** limits (code/docs plus **compute** overrides under `jobTypes.compute.watchdog`), notify, driver binaries, **docs repo presets** and default repo per job type (bearer-gated `GET`/`PATCH /api/settings`; form validation matches MCP `settings`)
- **MCP HTTP:** `POST http://127.0.0.1:9473/mcp` with `Authorization: Bearer $PRGENIE_RUNNER_TOKEN`
- **MCP stdio:** `pnpm local-runner mcp` (for Cursor `mcp.json`)

### MCP tools

- `start_job` — `repoPath` or `remote`, `branch`, `promptFile` (code jobs), optional **`jobType`** / **`profile`** (`docs` | code), optional **`docsTemplate`** (`marketing` | `policy` | `research`), optional **`expectPr`** (`false` → finish approved when build succeeds with no PR), optional `reviewPromptFile`, `fixPromptFile`, `maxRounds`, `model` (every stage), optional **`stageModels`** (`{ build, review, fix }`), optional **`driver`** (id), `dryRun`, optional `ticketUrl` / `linearIssue` (when omitted, the runner parses `issue-<n>` from the branch name), optional `ticketUrls` (every ticket the job covers; http(s), at most 10)
- `list_jobs` — optional `includeArchived` (archived jobs carry `archivedAt`)
- `get_job` — status + log tail (also resolves archived jobs, read-only)
- `steer_job` — queue follow-up text for the next agent step
- `stop_job`
- `archive_job` — `id`; removes a finished job from the dashboard (see [Removing jobs](#removing-jobs-archive)). Errors while the job is running.
- `restore_job` — `id`; moves an archived job back. Errors if a live job already uses that id.
- `continue_job` — `id`, optional `prompt` / `promptFile`, `extraRounds` (default 1), optional `model` (fix stage). Runs additional fix→review round(s) on a **terminal** job (`approved`, `changes_remaining`, `stuck`, `stopped`, `failed`, `interrupted`) when a PR exists. When there is **no PR yet**, any allowed terminal job re-runs its **build** stage on the same branch and worktree (`extraRounds` defaults to 0, and `model` overrides the build model). Refuses archived jobs (restore first), jobs a live worker still owns, and branches held by another active job.
- `restart_runner` — adoption preview for graceful HTTP restart (pair with `prgenie restart` or `POST /api/runner/restart`).
- `settings` — read (no args) or patch runner defaults (same shape as `PATCH /api/settings`).

### Job stages

`building` → `reviewing` (round N) → `fixing` → … → `approved` | `changes_remaining` | `stuck` | `failed` | `stopped` | `interrupted` (worker died; see [Restart and upgrade](#restart-and-upgrade-while-jobs-run))

Default **`maxRounds`** = 3 (review/fix cycles). N review rounds allow at most N−1 intervening fix passes. Reviewer must post **one** GitHub issue comment on the PR ending with `VERDICT: APPROVE` or `VERDICT: CHANGES` (built-in default review prompt enforces this). The runner also accepts the same `VERDICT:` line on PR review bodies as a fallback. If neither has a verdict for the round (for example, a custom `reviewPromptFile` that asks for a verdict line but not a PR comment), the runner reads the `VERDICT:` line from the reviewer's final message instead, posts that message to the PR as a comment so the fixer and humans can see it, and notes this in the job log. A posted GitHub verdict always wins over the local one. The job fails only when no verdict is found anywhere.

### Docs mode

Non-technical **docs** jobs worktree a **user-configured** business/policy repo (Setup presets + default for `docs`, or per-job `repoPath` / `remote` override). They use built-in implement/review prompts (`docsTemplate`: marketing, policy, research) and open **draft Markdown PRs**. GitHub Actions CI is **not** waited on; optional **doc checks** (markdown lint on changed `.md`) show as **Doc checks** on the dashboard. Draft→ready still requires **`VERDICT: APPROVE`** on the current HEAD and doc checks green (or N/A when disabled). No auto-merge.

Configure research/web in Cursor CLI: [`autoAcceptWebSearch`](https://cursor.com/docs/cli/changelog), WebFetch [`permissions.allow`](https://cursor.com/docs/cli/reference/permissions), headless [`--force`](https://cursor.com/docs/cli/using). Configure docs repo presets on the Setup screen (org/repo slug only in settings — never hardcode private paths in prompts).

MCP callers share the runner host owner's compute, Cursor login, and `gh` identity unless they run a separate runner + token.

### Dashboard (localhost UI)

Default implement prompt requires **`gh pr create --draft`**. After **`VERDICT: APPROVE`** on the current HEAD and **green CI** for that same HEAD, the runner runs **`gh pr ready`** once (stays draft if CI is pending/failed or head moves). Dashboard shows **Draft** vs **Ready** from GitHub `isDraft`. No auto-merge.

The jobs table shows **Ticket** (issue id), **PR**, **Ready** (draft/ready), **Status** (CI), **Model**, **Tokens** (summed from cursor-agent `stream-json` usage in the job log), and **Updated**. On narrow screens (~390px) rows become cards: the title uses the full card width (two lines, then an ellipsis) and a 44px ticket icon beside it opens the ticket in a new tab, or a short list when the job covers several tickets (`ticketUrls`, plus leading `#n` refs in a GitHub job's title). The job detail view shows a **Cursor-style agent transcript** (stream-json), optional raw log toggle, and a **Steer** box that queues follow-up text via the same bearer-protected API as MCP `steer_job`. **Email notifications** and runner defaults live on the **Setup** screen; settings persist in `$PRGENIE_RUNNER_DATA_DIR/settings.json` (legacy `notify-settings.json` migrates on first load). The Resend API key is never shown in the UI — only `RESEND_API_KEY` / `PRGENIE_RUNNER_RESEND_KEY_FILE` on the server. When the dashboard recipient is empty, notify email falls back to `PRGENIE_RUNNER_NOTIFY_EMAIL`. While a job has a PR, the runner polls CI on a modest interval during active stages and until checks settle on terminal jobs. It uses GitHub **`gh pr view --json statusCheckRollup`** first; when that is unavailable it falls back to **`origin pr checks`** when the Origin CLI can read the PR. The CI badge includes the source (`github` or `origin`).

Authenticated API: `GET` / `PATCH /api/settings`, `GET` / `PUT /api/notify-settings` (legacy) with bearer token (same as other `/api/*` routes). Out-of-range or wrong-type settings (`defaultMaxRounds` 1–10, `maxActiveJobs` 1–8, `watchdog.*` bounds, `expectedRevision`) return `400 { error }`; a stale `expectedRevision` returns `409`. A hand-edited out-of-range value already in `settings.json` is clamped on load instead of resetting the file.

`POST /api/jobs` and MCP `start_job` share one validator, so the same bad payload yields the same message (`400` over HTTP, a tool error over MCP): `branch` is required, `maxRounds` must be a number in 1–10, and `driver` / `jobType` / `profile` / `docsTemplate` must be known values. Starting a job on a branch that another running or queued job in the same repo already uses returns `409`; unexpected server failures return `500`.

At most `maxActiveJobs` jobs run at once; further starts are queued (shown as **queued** on the dashboard, removable before they start) and fill every free slot as running jobs finish. Each stage model is resolved once, at job start, from the first value set: the request's `stageModels.<stage>`, the request's `model`, Setup's per-stage model, the stage default (build: Setup default model; review: the Setup build model; fix: `auto`), then `PRGENIE_RUNNER_MODEL`. The fix default `auto` applies only to `cursor-agent`, so `PRGENIE_RUNNER_MODEL` never replaces it there; other drivers fix with the build model. When the watchdog kills a stalled agent, the child gets `SIGTERM`, then `SIGKILL` if it is still alive after the grace period.

**Compute-heavy jobs (`jobType: compute`):** same repo + prompt flow as code jobs, but the frozen watchdog snapshot uses longer built-ins (1h inactivity, 8h stage cap, 0 recovery attempts unless you override). Patch defaults under `settings.json` → `jobTypes.compute.watchdog`, or pass `watchdog` on `start_job` / `POST /api/jobs`. The per-stage watchdog still applies. For compute jobs only, it also treats **sustained CPU in a process the agent spawned** as activity, so a silent `blender`/`timeout` run is not mistaken for a stalled agent: one descendant (never the agent CLI itself) has to stay at or above 20% of a core for 3 consecutive 1s samples. An idle tree still trips the inactivity limit. Code and docs jobs count only agent output. CPU sampling reads `/proc` and is **Linux-only**; on other platforms compute jobs get only the longer limits. The detached worker supervisor's heartbeat and stage budget read the same snapshot (not live Setup values). On the dashboard, an open **Running** shell step shows elapsed time and optional process label, with CPU reported per core like `top` (`blender (270% CPU)` means about 2.7 cores busy); the detail header switches between **waiting on command** and **agent thinking**, and tool errors the agent later recovered from render dimmed.

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

| Route                             | Body                                             | Result                                                                                                                                              |
| --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/jobs/:id/archive`      | —                                                | `200 { ok, id, archivedAt, worktree: "removed" \| "kept" \| "none", warning? }`                                                                     |
|                                   |                                                  | `409` while running (`{ error, stage }`), `404` unknown id, `400` invalid id                                                                        |
| `POST /api/jobs/:id/restore`      | —                                                | `200 { ok, id, stage }`; `409` on id collision, `404` not archived                                                                                  |
| `POST /api/jobs/:id/continue`     | `{ prompt?, promptFile?, extraRounds?, model? }` | `200 { ok, id, stage, maxRounds, reviewRound, worktree, queued }`; `409` running/archived/branch; `400` validation (parity with MCP `continue_job`) |
| `POST /api/jobs/clear-failed`     | `{ "includeStuckStopped"?: bool }`               | `200 { ok, stages, archived: [ids], warnings: [{ id, warning }], skipped: [{ id, error }] }`                                                        |
| `GET /api/jobs?includeArchived=1` | —                                                | Live jobs plus archived ones                                                                                                                        |
| `GET /api/jobs/meta`              | —                                                | `{ totalOnDisk, mergedHidden, archived }`                                                                                                           |
| `GET /api/events?token=…`         | —                                                | SSE: `data: {"type":"jobs"}` whenever a job is started, archived, or restored                                                                       |

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

Jobs are JSON under `$PRGENIE_RUNNER_DATA_DIR/jobs/` (archived ones under `archived/jobs/`, see [Removing jobs](#removing-jobs-archive)). Runner settings (notify, defaults, drivers, reserved `jobTypes` / `presets` bags) live in `$PRGENIE_RUNNER_DATA_DIR/settings.json`.

## Restart and upgrade while jobs run

HTTP `serve` runs each active job in a **detached `job-worker` process** (own PID, logs on disk). Upgrading `main` no longer requires waiting for every slot to drain: rebuild, then restart the HTTP front-end; workers keep running through the relaunch.

| Action                              | CLI                                                                        | MCP                                                                                              | HTTP                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Graceful shutdown + relaunch helper | `prgenie restart` (`--build` runs `pnpm build` first, aborting on failure) | `restart_runner` (preview adopt/interrupt lists; pair with `prgenie restart` or your supervisor) | `POST /api/runner/restart` (responds then exits **only** the HTTP/MCP server) |

**`prgenie restart [--build]`**, in order:

1. With `--build`, runs `pnpm build` at the repo root (the nearest directory above the runner entry that has `pnpm-workspace.yaml`; npm installs have none, so `--build` errors there). A failed build exits `1` and leaves the old server running.
2. Calls `POST /api/runner/restart`. Any status other than `200` (for example `401` on a wrong token) exits `1` without relaunching. If nothing is listening, it skips straight to launching.
3. Waits for the old server to release the port, then launches `serve` detached and waits until `/api/jobs/meta` answers.

**Shutdown:** the restart endpoint flushes its response, then ends every dashboard event stream (`/api/events`, `/api/jobs/:id/stream`), stops listening, closes idle keep-alive sockets, and cuts any request still running after 2s. Open dashboards therefore cannot hold the restart; they reconnect to the new server. `SIGINT` on `serve` takes the same path.

**Ownership:** a worker claims its job by creating `$PRGENIE_RUNNER_DATA_DIR/workers/<job-id>.lock` with `O_EXCL`, recording its PID, hostname, a random token, and the OS process start time (`/proc/<pid>/stat` on Linux, `ps -o lstart` on macOS). A second worker for the same job, from a duplicate spawn or two `serve` processes starting at once, finds a live holder and exits `3` without touching the job. A dead holder's lock is replaced under the store lock. A PID whose start time no longer matches counts as dead, so a recycled PID is never adopted or signalled. The job JSON mirrors the claim in `worker`. On exit the worker releases both, but only while its token still owns them, and the cleared `worker: null` persists through later saves of older copies.

**Adoption and supervision:** the next `prgenie serve` (or the relaunch that `prgenie restart` spawns) **re-adopts** live workers. The stage machine and per-stage watchdog keep running in the worker. The serve process forwards the worker's stage, PR, and log progress to dashboard event streams, and supervises the worker using the job's own watchdog snapshot instead of a fixed total:

- **Heartbeat:** the worker refreshes its lock every 5s. If it stays silent longer than the job's watchdog inactivity limit, the worker is treated as hung (for compute jobs on Linux, agent log silence with a busy child under the agent still counts as active for the stage watchdog).
- **Stage budget:** a single stage may run for at most `stageCapMs × (recoveryAttempts + 1)` plus kill grace and 5 min of slack, counted from when that stage started (or from when the worker started, whichever is later).
- A hung or over-budget worker gets `SIGTERM` to its process group, then `SIGKILL` after a grace period. The job is marked only once the process is confirmed gone. A healthy worker is never abandoned, however long the job runs.

When a worker is confirmed dead and its job is still `building` / `reviewing` / `fixing`, the job becomes **`interrupted`** (or `stopped` if a stop was pending) and is never silently dropped. Resume it with `continue_job` / `POST …/continue`. A terminal job with no PR yet (including `stuck` from the no-PR guard) re-runs its build stage on the same branch and worktree.

**Idle restart** (no `building` / `reviewing` / `fixing` jobs) behaves as before.

Env: `PRGENIE_RUNNER_ROLE=serve` (set automatically by `prgenie serve`). Stdio `mcp` still runs jobs **inline** (`PRGENIE_RUNNER_INLINE_JOBS=1` inside workers). Do not point restart helpers at a production port (default `9473`) from tests or automation without an isolated `PRGENIE_RUNNER_DATA_DIR` and port.
