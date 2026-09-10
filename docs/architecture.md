# Architecture

PR Genie is a local review lane that sits in front of GitHub. The product flywheel (implementor → local PR → reviewer → export) is explained in the [root README](../README.md). This page describes how the pieces fit together.

## Packages

| Package                    | Path                 | Role                                                                                                                                                      |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prgenie/core`            | `packages/core`      | Local PR CRUD, status transitions, watch state, worktrees, export helpers, `doctor`, `gh` bind                                                            |
| `prgenie` CLI              | `packages/cli`       | Thin CLI + MCP stdio server over core (`prgenie`, `prgenie doctor`, `watch listen`, hooks)                                                                |
| Cursor plugin              | `packages/plugin`    | Rules, skills (`/start-loop`, `/export-local-pr`, …), MCP entry, hooks (`github-gate.cjs`, `review-inbox.cjs`, `capture-subagent.cjs`, `session-log.mjs`) |
| VS Code / Cursor extension | `packages/extension` | **Local PRs** sidebar: watch list, Switch to worktree, Complete review, Open on GitHub                                                                    |

Build at the monorepo root (`pnpm build`). Dev install copies the plugin and extension into Cursor via `pnpm link-plugin` and `pnpm link-extension`.

## How the pieces connect

```text
Cursor chat (skills + MCP)
        │
        ▼
  packages/cli  ──►  @prgenie/core  ──►  git (.git/agent-console, refs/local-pr)
        ▲
        │
  hooks / github-gate (plugin)
        │
  Local PRs sidebar (extension) ── Switch / export UI
```

- **CLI + core** — create/list/update/approve local PRs from any worktree of the same repo. Same APIs the MCP server exposes.
- **Cursor plugin** — steers agents (no push without `/export-local-pr`), registers slash skills, runs MCP `prgenie`, and installs hooks that gate `git push` / `gh`, capture subagent finishes, and nudge review loops.
- **Extension** — spectator GUI. It does not replace Cursor's Task tool; it shows loops as they land and can switch this window onto a loop worktree.

## Local PR lifecycle

Statuses (from `@prgenie/core` types):

`draft` → `ready` → (`changes_requested` | `reviewed`) → `approved`

Typical path:

1. **Create** (`create_local_pr` / `prgenie create` / `/start-loop`) — feature branch `lp-<id>`, draft packet. `createLocalPr` always calls `ensureWorktreeForLoop` and records a `worktreePath`. That path is `../<repo>.loops/<id>` (`loopWorktreeDir`) unless the loop branch is already checked out in the primary tree, in which case the primary path is reused. The worktree attachment is required; only the _location_ (sibling `.loops/<id>` vs primary) varies.
2. **Ready** — implementor refreshes `body` (why / what / how to test), then `set_status ready` / `prgenie ready`. That only arms the review request (`armReviewRequest`: sets `reviewRequestedSha`, clears `reviewerNotifiedSha`). It does **not** post a comment. On the first draft→ready handoff, agents `add_comment` **Review requested.** themselves (skills / `formatSpawnReviewer`). After later review rounds, addressing the last open finding runs `maybeHandoffToReviewer`, which returns `ready` and posts that comment automatically.
3. **Review** — reviewer files findings while status stays `ready`, then **`complete_review`**. That flip wakes the implementor (`changes_requested`) or marks `reviewed` for export.
4. **Address** — implementor `address_comment`s each open finding; addressing the last open finding returns `ready` and posts Review requested again.
5. **Resolve + complete** — reviewer resolves addressed comments, then always `complete_review`.
6. **Export** (`/export-local-pr` / `export_local_pr`) — push + `gh pr create`, status `approved` (archived, not deleted), listen lanes halted for that export id.

Human comments can request changes immediately; agent/reviewer findings go through address/resolve.

**Head drift:** when Review requested is armed (`reviewRequestedSha`), if HEAD moves before `complete_review`, complete fails unless `--force` / `allowDrift` — re-diff first.

## Watch lanes

Two independent lanes under `.git/agent-console/watch.json`:

| Lane    | Skill                 | Who                                        |
| ------- | --------------------- | ------------------------------------------ |
| `inbox` | `/watch-review-inbox` | Implementor — wakes on `changes_requested` |
| `queue` | `/watch-ready-prs`    | Reviewer — wakes on `ready`                |

- `prgenie watch listen inbox|queue` is the capped wake process (default **30m** idle quiet, **8h** wall max). Skills should use it instead of hand-rolled sleep loops.
- Halt reasons: `stop` (explicit `/stop-loop`, `/stop-review`, `/stop-watch`) vs `export` (after `/export-local-pr`).
- Creating a new loop resumes **export**-halted lanes only when that export id is archived or missing. It does **not** clear a `stop` halt.
- Listen exits with `AGENT_LOOP_DONE_*` and reason `idle` | `max` | `ticks` | `stop` | `export`. Re-run the watch skill to continue after idle/max.

## Where state lives

All local-PR state is git-native / machine-local — not committed:

| Location                                             | Contents                                                 |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `refs/local-pr/<id>/head`, `refs/local-pr/<id>/base` | Branch tips for the loop                                 |
| `refs/notes/local-pr`                                | Notes                                                    |
| `.git/agent-console/prs/<id>.json`                   | Packet metadata (title, body, status, comments, SHAs)    |
| `.git/agent-console/watch.json`                      | Inbox/queue halt + export id                             |
| `.git/agent-console/sessions.jsonl`                  | Session log events                                       |
| `.git/agent-console/github.json`                     | Per-repo `gh` login bind (`bindFile` in `github-ops.ts`) |

`prgenie list` / MCP `list_local_prs` hide archived (`approved`) loops unless `--all` / `all=true`. Packets remain on disk for `prgenie show` and Local PRs **Show archived**.

## Worktrees

- Primary checkout: the main repo folder (e.g. `…/pr-genie`).
- Loop worktrees: sibling path `../<repo>.loops/<id>` (e.g. `…/pr-genie.loops/lp-3b8dbf41`).
- Each loop owns a feature branch; never use the repo base (`main`/`master`) as head.
- **Switch** in Local PRs reopens this window on that loop's worktree.
- Export checks the main workspace off the loop branch onto the loop base and removes the sibling `.loops/<id>` checkout. If the window is still on that extra worktree, PR Genie reopens the primary folder first.
- Cursor may auto-clean worktrees; the loop packet remains. Orphans (`.loops` trees with no live local PR) show up in `prgenie doctor`.

## GitHub account bind

`gh auth` is global — only one account is active at a time. Per repo:

- `prgenie gh use <login>` / MCP `gh_use` binds this project (writes `.git/agent-console/github.json`).
- Before push / `gh`, the github-gate hook switches to the bound account.
- Export refuses to guess an unbound login.

## Plugin surface (skills / MCP / hooks)

Skills (one slash name each — do not also add duplicate `commands/*.md`):

`/start-loop`, `/local-pr`, `/review-local-pr`, `/watch-ready-prs`, `/watch-review-inbox`, `/review-queue`, `/review-inbox`, `/stop-loop`, `/stop-review`, `/stop-watch`, `/export-local-pr`

MCP server name: `prgenie` (tools such as `list_local_prs`, `create_local_pr`, `set_status`, `complete_review`, `export_local_pr`, `watch_status`, `gh_use`, …).

Hooks registered in `hooks.json`:

- `github-gate.cjs` — push / `gh pr create` gate + bound-account switch
- `review-inbox.cjs` — review-loop nudges for the implementor inbox
- `capture-subagent.cjs` — subagentStop capture into local PRs
- `session-log.mjs` — session log helper used by hooks

## See also

- [Troubleshooting](troubleshooting.md) — doctor checks and common failure modes
- [ROADMAP.md](../ROADMAP.md) — gap analysis (H6 was this docs work)
