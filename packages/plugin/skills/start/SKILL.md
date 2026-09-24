---
name: start
description: Kick off implementor work from a ClickUp, Jira, Linear, or GitHub ticket or a chat brief. Creates a feature branch and a local PR. Use only when the user runs /start, asks to start a loop, or explicitly asks to use PR Genie.
disable-model-invocation: true
---

# Start implementor work

You are the **implementor**. Do not review your own loop. Do not `git push` unless `/export`.

This skill is **implementor-only**. It is not `/steward`. Do not become the steward. Do not Task a reviewer. Do not arm inbox/queue listen (`/watch-inbox`, `/watch-ready`, `prgenie watch start|listen` — those are gone).

Prefer **`/steward`** when the user wants **one** agent to own implement ↔ review until Push to origin. If they ran `/start`, you implement here and stop when ready.

This is how work _enters_ a loop as the worktree agent. A ticket MCP or a message in this chat is enough. Do not wait for a local PR that does not exist yet.

## Brief

Take the work from, in order:

1. **This message** — a ticket URL/id, or a plain-language brief the user typed.
2. **An attached MCP** — if they named ClickUp, Jira, Linear, GitHub Issues, etc., discover that namespace (`GetDynamicTools`) and fetch the issue. For ClickUp, `clickup_get_task` with `include: ["description"]` (task id from `/t/<id>` or a custom id like `DEV-1234`). Chat-thread URLs ending in `/t/<id>` are messages, not tasks.
3. **Ask once** — if there is still no brief, ask for a ticket link or a short description. Then stop until they reply.

Do not invent a task. Do not start coding with an empty brief.

Write the brief down as:

- **Title** — ticket title, or one line from the user
- **Body** — ticket description plus acceptance notes; include the ticket URL/id when you have one

## Branch and packet

Stay off the repo base (`main`/`master`). `create_local_pr` checks out `lp-<id>` when this window is on the base, and peels a branched worktree when it must — never detached, never a PR whose head is the base. Creating the loop **resumes export-halted lanes** only when that export id is **archived or missing**. It does **not** resume while the export id is still live.

1. If this branch already has a live (not archived) local PR, use it (`update_local_pr` to put the brief in `body` if empty). Do not open a second loop on the same branch.
2. Otherwise MCP `create_local_pr` with `title` and `body` (the brief). That creates the feature branch and the draft loop.
3. **Immediately Switch / open `worktreePath`** (Local PRs **Switch**, or reopen this window on the exclusive `../<repo>.loops/<id>` path). Show the id, `head → base`, `worktreePath`, and the brief.
4. **All** edits, commits, and CI run in that worktree. Never implement or commit in the primary folder when an exclusive worktree exists.

If create refuses because primary has dirty tracked plugin build artifacts (`packages/plugin/hooks|mcp/*.cjs`): stash or `git restore` those paths on primary, then retry create.

## After the work

While coding (not only at the end):

1. After each **substantive edit batch**, run **targeted** lint/format/type on the paths you touched (or MCP `run_ci` / `prgenie ci` so smart CI scopes them). Prefer the scoped command the progress card shows (`eslint path1 path2`, `lint:core`, turbo `--filter`, …).
2. **Forbid** “implement everything → one surprise full `pnpm lint` / `pnpm test` / `eslint .`” when a scoped command exists. Do not widen eslint ignores or disable rules unless the ticket says so — fix to existing project rules. **Scoped only:** if `run_ci` cannot confidently scope, it **skips** with a printable reason — then skip or manually run only touched-package tests; **never** escalate to root monorepo `pnpm test` / full suite (RAD-119).
3. Ready / Review requested only after **green** `run_ci` for HEAD, a **skip plan** with printed reason (recorded on the loop), or an **explicit** `ciSkipReason` / `CI skipped: <reason>` comment — `set_status ready` soft-blocks otherwise (RAD-97).

Then:

1. Commit on this branch **in the exclusive worktree** if needed. Do not push. Do not commit on primary.
2. Refresh `body` to a reviewer summary: why, what changed, how to test (keep the ticket link).
3. Run MCP `run_ci` / `prgenie ci <id>` (path-scoped checks from changed files vs base — see `docs/ci-checks.md`). **Print** the returned `{ checks, reason }` plan in chat. When mapping is confident (`packageScoped` / reasons say so), do **not** run whole-repo `pnpm test` as a substitute. When mapping **skips** (`skipped` / empty `checks`), do **not** run full suite — record the skip reason or manually run only touched-package tests (RAD-119). On host repos, when progress shows path-scoped `eslint …`, do **not** replace it with root `eslint .`. Fail-fast stops after the first package suite fail — do not keep running later packages. Skip only if the toolchain cannot run or selection skipped — say so.
4. **On red CI (RAD-121):** print `{ checks, reason }`, open the failing log (progress card / `.git/agent-console/ci-logs/<check>.log`), fix the named assertion or file, then re-run **only that file** (or that **one** check name) once per edit. **Do not** relaunch the multi-check scoped plan after a known failure. **Do not** overlap `run_ci` copies (no second plan while one is still running). Still format the files you edited — the ban is full-suite / plan relaunch, not `format:check` on the diff. See the wrong-vs-right example in `docs/ci-checks.md` (Red CI retry).
5. `set_status` `ready` and `add_comment` `role=agent` **Review requested.** (Review-requested upserts one root per SHA — duplicates collapse.)
6. **Stop.** If a steward (`/steward`) is driving this loop, it will Task the reviewer. If the user used `/start` alone, tell them to run `/steward` on this packet (or `/review`) — do not review it yourself and do not start listen.
7. Reviewer auth failure → MCP `mark_review_interrupted` / `prgenie review-interrupted`; resume with `resume_review` / `prgenie review-resume` (same Task, no re-brief). Session reconnect injects a Task↔loop digest (`reconcile_session` / `prgenie reconcile`).
