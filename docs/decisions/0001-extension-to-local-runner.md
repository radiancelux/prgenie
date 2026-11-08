# ADR 0001: Pivot from Cursor extension/plugin to local runner

|            |            |
| ---------- | ---------- |
| **Status** | Accepted   |
| **Date**   | 2026-11-07 |

## Context

PR Genie began as a **Cursor-native** product: a plugin (rules, slash skills, MCP, github-gate hooks), a VS Code/Cursor **extension** (Local PRs sidebar, worktree switch, export UI), and a shared **`@prgenie/core` + CLI** layer over git-native loop state (`.git/agent-console/`, `refs/local-pr/`).

The intended flywheel was **editor-bound orchestration**:

1. A human opens **one steward chat** (`/steward`) per local PR.
2. The steward **Tasks** an implementor, then a reviewer, resumes the same implementor on `changes_requested`, and runs a **local export gate** (path-scoped `run_ci` / shepherd) before handoff.
3. The human **exports** to GitHub when the gate is green (`prgenie export` / Open on GitHub).

That design worked for single-loop, single-window local development but accumulated structural pain:

| Pain point                    | Why it hurts                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Editor-bound loops**        | Steward, Tasks, MCP, and the sidebar share one Cursor window and extension host. Long CI, overlapping polls, and uncapped agent wakes create host lag; the spectator UI can stall while CLI still works. |
| **Local-only CI as gate**     | Ready/export gates lean on **worktree-local** scoped checks. They approximate production but are not the same as **GitHub Actions** on a real PR branch.                                                 |
| **Windows stability**         | Plugin link paths, MCP pinning, `%USERPROFILE%` copies, and heavy local CI multiplied process churn on Windows workstations.                                                                             |
| **Human-in-the-loop export**  | Push/`gh pr create` stay **human-only** by design (github-gate). The implementor loop completes locally; GitHub is intentionally late in the pipeline—good for safety, slow for automation.              |
| **Parallel install surfaces** | Plugin MCP, extension VSIX, and CLI dist go stale independently; `prgenie doctor` mitigates but cannot unify lifecycle.                                                                                  |

Meanwhile, **`local-runner/`** grew into a **workstation orchestrator**: HTTP MCP + dashboard, pluggable AI CLI drivers (`cursor-agent` by default), isolated git worktrees, and a job loop that targets a **real GitHub draft PR** so **remote CI** becomes the review bar.

## Decision

Adopt the **local runner** as the **primary automation path** for implement → review → fix → merge-ready PRs. Keep the extension, plugin, and CLI as **libraries and optional Cursor integrations**, not the main orchestration plane.

**Target workflow**

```text
Orchestrator (chat bot, scheduled job, or human operator)
 │
 │ MCP start_job / HTTP API (bearer token)
 ▼
Local runner (localhost: serve + dashboard)
 │
 ├── worktree under ~/.cursor/worktrees/<slug>/<job-id>
 ├── cursor-agent: implement (prompt file) → gh pr create --draft
 ├── cursor-agent: review → VERDICT on GitHub PR comment/body
 ├── cursor-agent: fix rounds (default maxRounds = 2)
 ├── poll GitHub / Origin for CI on PR HEAD
 └── gh pr ready when VERDICT APPROVE + green CI (+ docs checks for docs jobs)
 │
 ▼
GitHub PR + Actions ← source of truth for CI
 │
 ▼
Human merges on GitHub (no auto-merge in runner)
```

**Roles**

- **Orchestrator** — anything that can call runner MCP or the dashboard API with a shared bearer token (another agent, a cron wrapper, or an operator). Not tied to Cursor sidebar or steward Task ids.
- **Runner** — owns process supervision, logs, worktrees, email notify (optional Resend), and stage machine (`building` → `reviewing` → `fixing` → terminal states).
- **Human** — merges the PR on GitHub; runner does not auto-merge.

**CI truth**

- Extension era: local `run_ci` / shepherd gate before export.
- Runner era: **GitHub (or Origin) check rollup on the open PR** drives draft→ready promotion and dashboard badges; local doc checks apply only to docs-mode jobs.

## Consequences

### Positive

- Decouples long-running agent work from the **extension host** and steward chat lifecycle.
- Every job is anchored to a **real PR**, so contributors and maintainers see the same CI as production.
- **Dashboard + SSE logs** give operator visibility without parsing Cursor chat.
- **Steer/stop** APIs support mid-job correction without sidebar state.
- Worktrees live outside the primary repo checkout, reducing exclusive-worktree collisions with day-to-day editing.

### Negative / tradeoffs

- Requires a **long-lived runner process**, `PRGENIE_RUNNER_TOKEN`, `gh auth`, and Cursor CLI (`cursor-agent`) on the workstation.
- Loses the **fully local** loop until first `gh pr create`; without `expectPr: false`, no-PR completion is **`stuck`**, not reviewed.
- Steward/Task orchestration, subagent capture, and sidebar polish remain **extension/plugin** concerns—two mental models until docs and UX converge.
- Email notify depends on **Resend** configuration; optional but another secret surface.
- LAN/mobile dashboard bind (`0.0.0.0`) needs firewall discipline; not a hosted multi-tenant service.

## What still lives in extension / plugin / CLI

| Package              | Still provides                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `@prgenie/core`      | Local PR CRUD, worktrees, export, shepherd CI selection, doctor, gh bind—shared by CLI and plugin MCP.   |
| `packages/cli`       | Terminal and MCP stdio entry for local PR workflows; `prgenie steward`, `run_ci`, export.                |
| `packages/plugin`    | Cursor rules/skills (`/steward`, `/start`, `/review`, …), github-gate, optional subagent capture.        |
| `packages/extension` | Local PRs sidebar, switch worktree, complete review, Open on GitHub—for humans watching **local** loops. |

The runner **does not** replace github-gate or local packet storage; it **bypasses** them for automated GitHub-first jobs by operating in a dedicated worktree and using GitHub review verbs (`VERDICT:`) instead of `complete_review` on a local packet.

## Migration notes for extension users

1. **Install runner** — `pnpm build` from monorepo root; set `PRGENIE_RUNNER_TOKEN`; run `pnpm local-runner serve`. See [local-runner/README.md](../../local-runner/README.md).
2. **Point MCP** — Add HTTP or stdio MCP for the runner (`pnpm local-runner mcp`) alongside or instead of plugin `prgenie` MCP when automating GitHub PR loops.
3. **Prompt files** — Supply `promptFile` / `reviewPromptFile` / `fixPromptFile` (or built-in defaults) instead of relying on `/steward` skill prose in chat.
4. **Review contract** — Reviewer agent must end with `VERDICT: APPROVE` or `VERDICT: CHANGES` on the GitHub PR (comment or review body); local `complete_review` is not the gate.
5. **Keep extension for local PRs** — Interactive local-only review (no GitHub until export) remains valid; use runner when CI on GitHub should drive merge readiness.
6. **Secrets** — Runner token protects localhost UI/API; do not commit tokens or Resend keys. Use `.env` locally (see `.env.example`).

## References

- [Architecture](../architecture.md) — extension-era packages and lifecycle
- [local-runner/README.md](../../local-runner/README.md) — runner configuration and MCP tools
- [docs/drivers.md](../drivers.md) — AI CLI driver adapter contract
