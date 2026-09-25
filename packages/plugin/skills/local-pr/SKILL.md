---
name: local-pr
description: Create and update unpublished PR Genie local pull requests (branch, diff, comments, status). Use only when the user runs /local-pr, asks for a local PR or loop, or an existing live loop needs updating.
disable-model-invocation: true
---

# PR Genie local PRs

Do not push. Local create is **opt-in** — slash `/local-pr`, `/start`, `/steward`, or an explicit “use PR Genie” / “start a loop”. Ready-for-review alone is not enough.

**Model tiers:** `/steward` Tasks `prgenie-implementor` (cheap) or `prgenie-implementor-strong` (explicit `tier: strong` marker / two reviewer rejections) and `prgenie-reviewer` (strong) — never `generalPurpose`. See `/steward` “Model tiers”.

`subagentStop` auto-capture is **off by default**. Set `PRGENIE_CAPTURE_SUBAGENT=1` to draft a loop when a coding subagent commits and stops. Explore/shell subagents with no file changes are ignored.

To **start** a full flywheel (one agent owns implement ↔ review): `/steward` with a ticket or brief. Implementor-only entry remains `/start`. Either creates the feature branch and the draft packet. Do not stay on `main`.

## Create

```
prgenie create --title "..." --body "## Summary\n- ...\n\n## Test\n- ..." --base main
```

Or MCP `create_local_pr` with `title` and **`body`**. `body` is the loop summary for reviewers — not optional when you are the implementing agent.

Write it like a GitHub PR description:

- Why this exists
- What changed (bullets)
- How to test

If the loop already exists, `update_local_pr` with `body` (or `prgenie update <id> --body "..."`). Fill the summary before `set_status ready`.

## Inspect

- `prgenie list` (hides `approved` / exported loops)
- `prgenie list --all` to include the archive
- Local PRs sidebar: **Archive (N)** chevron section (default collapsed; workspace preference `prgenie.archiveExpanded`) to view exported/approved packets (read-only; worktrees are gone). **Clear archived** permanently deletes local packets, worktrees, and local loop branches — remotes stay.
- `prgenie show <id>` still works after export
- `prgenie diff <id>`
- MCP `list_local_prs` (same archive filter; `all=true` or `status=approved` to see them), `get_local_pr`, `get_diff`

## Status

`draft` → `ready` (reviewer files findings; status stays `ready`) → `complete_review` → `changes_requested` (findings) or `reviewed` (clean) → `ready` (second pass) → `reviewed` → `approved`

`reviewed` means the automated reviewer found nothing else — **review cleared**. The steward runs the export gate next. It is **not** a human handoff. `approved` is you signing off / export. Approved loops are **archived**: JSON and `refs/local-pr/*` stay; they are hidden from the default list. Local PRs shows them under **Archive (N)** when expanded (read-only). `get_local_pr` / `prgenie show` still work. A later `create_local_pr` / `captureAgentWork` on that branch starts a new loop.

### Comments

Findings (`role=human` or `role=reviewer`) have their own status:

| status      | Who sets it                                                        | Meaning                                                           |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `open`      | Human or reviewer filing a finding                                 | Implementor inbox **after** `complete_review` (`pendingComments`) |
| `addressed` | Implementor via `address_comment` (reply nested under the finding) | Waiting for the reviewer to verify                                |
| `resolved`  | Reviewer via `resolve_comment`, or `complete_review`               | Closed                                                            |

`complete_review` is always the end of a reviewer Task. Open findings set the loop to `changes_requested`. No open findings set `reviewed`. Resolving addressed comments does not finish the review.

Comments are the review protocol for the agent on that loop:

| role       | Who                        | Effect                                                                                                                 |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `human`    | You (GUI, CLI, chat)       | Open finding. Loop → `changes_requested` immediately (including from **draft** — that is intended).                    |
| `reviewer` | Automated review agent     | Open finding. **Does not** change loop status. Call `complete_review` when finished.                                   |
| `agent`    | The implementer on this PR | Reply, nested under the finding. Use `address_comment`. The last open finding sets `ready` and posts Review requested. |

`pendingComments` are **open** findings. The implementor inbox (`prgenie inbox`, `inbox=true`) is **this worktree's loop only**, and only when status is `changes_requested`. Never grab another loop. Comments on a `ready` loop mean the reviewer is still writing. `addressedComments` are waiting for the reviewer. Agent replies render **under** the parent finding, not as a stack of sibling comments.

## Address comments

If the current branch's local PR is `changes_requested`:

1. `get_local_pr` and read `pendingComments` (open human/reviewer notes; each has an `id`).
2. Fix on the current branch. Commit if needed **before** addressing.
3. For **each** open comment, MCP `address_comment` (or `prgenie address`) with that `commentId` and a reply (what you changed). Mid-inbox status stays `changes_requested`. The last open finding sets the loop to `ready`, refreshes HEAD, and posts **Review requested.** so the steward can Task the next review. Run `prgenie ci <id>` / MCP `run_ci` before that last address when you can, so ready is not a surprise-fail for the export gate.
4. Confirm status is `ready`. Do not `git push`. Do not review your own loop. Do not `resolve_comment` — that is the reviewer's job.
5. If status is still `ready` with a review in progress (open findings, no `complete_review` yet), wait. Do not address comments until `complete_review` flips the loop to `changes_requested`.

## Requesting review

You are the agent **on the worktree** (implementor). While coding: after each substantive edit batch, run **targeted** lint/format/type (or scoped `run_ci`) on touched paths before declaring done. Forbid implement-everything then one full `pnpm lint` / `pnpm test` / `eslint .` surprise when a scoped command exists. **Scoped only** (RAD-119): if mapping cannot be confident, `run_ci` skips with a printable reason — skip or manually run touched-package tests; never escalate to full suite. On CI fail, fix to existing project rules (no disable-eslint / widen-ignores unless the ticket says so).

On completion:

1. Loop exists, `body` is a real summary, HEAD matches the work.
2. Run MCP `run_ci` `{ id }` or `prgenie ci <id>` (path-scoped checks from the loop diff — `docs/ci-checks.md`). **Print** `{ checks, reason }` from the result. Prefer fix-before-ready over discover-via-gate. When mapping is confident, **forbid** substituting whole-repo `pnpm test`; use the selected scoped cmds only. When `skipped` / empty `checks`, **forbid** full suite — use the printed skip reason or manual touched-package tests only. On host repos, trust path-scoped `eslint …` / turbo `--filter` from the progress card — do not escalate to `eslint .`. Fail-fast stops after the first package suite fail. Skip only if the toolchain cannot run — say so in the Review requested comment — or when a human gives an **explicit skip reason** (RAD-97), or when selection itself skipped with a reason.
3. **On red CI (RAD-121):** print `{ checks, reason }`, open the failing log (progress card / `.git/agent-console/ci-logs/<check>.log`), fix the named assertion or file, then re-run **only that file** (or that **one** check name) once per edit. **Do not** relaunch the multi-check scoped plan after a known failure. **Do not** overlap `run_ci` copies. Still format the files you edited — the ban is full-suite / plan relaunch, not `format:check` on the diff. Wrong-vs-right: `docs/ci-checks.md` (Red CI retry).
4. On CI-resume (export gate blocked): re-run at least the failing check(s) (`prgenie ci <id> --failing lint,test`) — not a fresh full scoped plan — and only return when they pass. Same red-CI file/check unit of retry as above.
5. `set_status` `ready` (soft-blocked until green `run_ci` / recorded skip — RAD-97).
6. `add_comment` `role=agent`: `Review requested.` (single root per SHA).
7. **Stop.** If a **steward** (`/steward`) is driving this loop, it will Task the reviewer. Do not start listen. Do not review this loop yourself.
8. When review is done, status is `changes_requested` (findings) or `reviewed` (review cleared — steward runs the export gate). Treat `pendingComments` as the brief only after `changes_requested`. Do not wait for a DM; the loop is the channel. Do not start on comments while the loop is still `ready`. Do not say ready-for-human until `handoff_human`.
9. Auth/host death mid-review → `mark_review_interrupted` / `review-interrupted`; one-command `resume_review` / `review-resume` without re-brief. On session reconnect, `reconcile_session` / `prgenie reconcile` digests Task ids vs loop status.

`/export` is the developer cutting the GitHub PR at origin.

## Worktrees

Each loop has a **feature branch** for export (never `main`/`master`) and an exclusive sibling `../<repo>.loops/<id>` worktree — never the primary folder. If this window is on the base, PR Genie creates `lp-<id>` without switching primary onto it, then peels the `.loops/<id>` checkout (`-b` when needed — never detached). If the branch was already checked out in primary, PR Genie moves primary back onto the loop base and peels the exclusive worktree.

**After create:** Switch / open `worktreePath` before any edits. All commits and CI run there. Never implement in the primary folder when a loop worktree exists. `prgenie worktree <id>` / MCP `ensure_worktree` only creates the checkout — they do not open the editor.

`create_local_pr` / `prgenie doctor` refuse or warn when primary has dirty **tracked** plugin build artifacts (`packages/plugin/hooks|mcp/*.cjs`). After the RAD-113 migration those paths are gitignored — if you still see tracked dirt, stash/`git restore` or rebase off a pre-migration branch. Doctor `plugin-bundles` fails when generated bundles are missing or stale versus sources (`pnpm build`).

Do not delete worktrees unless the user asks. Do not create extras beyond the one per loop. After **export**, PR Genie checks the main workspace off the loop branch (onto the loop base) and removes the sibling `../<repo>.loops/<id>` checkout. The primary repo folder is never deleted. If this window is still on the extra worktree, reopen the primary folder — the sidebar does that, then the extra checkout is cleared.

## GitHub accounts

Bind is **per repository**, stored in `.git/agent-console/github.json` (not committed). `gh` still has only one active login globally; the bind is how this repo keeps the right one.

**Who sets it**

- The user can run `prgenie gh use <login>` once in that repo.
- Or they name the account in chat ("use radiancelux for this project"). Then the agent calls MCP `gh_use` with that login.
- If the repo is unbound and GitHub work is needed, the agent lists accounts with `gh_list` / `prgenie gh list` and **asks which login** — it does not guess.

After a bind exists, do not `gh auth switch`. The hook switches to the bound account before `gh` / `git push`.

```
prgenie gh list
prgenie gh use <login>
```

## Open on GitHub

`reviewed` means the automated reviewer is done (review cleared). When the export gate is ready (`handoff_human`), Local PRs shows **Push to origin**. **Open on GitHub** pushes the loop branch and creates the GitHub PR (`/export` does the same). **Archive locally** keeps it local only (no GitHub).

Only open on GitHub if you explicitly want to publish. That marks the loop `approved` (archived). Late reviewer comments cannot un-archive it. If GitHub already merged that head, PR Genie archives the local packet on list/refresh.
