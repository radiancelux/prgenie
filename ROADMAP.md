# PR Genie — Gap analysis and roadmap

Grounded in a full survey of the code as of `main` (post PR #5): `packages/core`, `packages/cli`, `packages/plugin`, `packages/extension`, the skills/rules/hooks, and the flywheel workflow (implementor ↔ reviewer ↔ human, steward-orchestrated). Each item names the gap, why it matters, and where the change lands.

**Source of truth for open work:** [Linear — PR Genie](https://linear.app/radiancelux/project/pr-genie-321d0131c80d). This file mirrors Linear; do not invent priorities here.

**Status:** Now items 1–4 and Next items 5–10 are implemented on this branch line. Later #11–17 shipped (history surface, search/filter, test debt + lint, release discipline, gh bind UI, docs, sidebar rename). Learn #18–20 shipped (pattern memory + preflight, sessions digest, export shepherd gate). **A8 steward-per-local-PR shipped (RAD-70)** on top of the RAD-71 export gate; **RAD-81** removed the listen/watch flywheel so `/steward` is the only orchestrator. **RAD-65** (H5 sidebar search) and **RAD-86** (MCP default cwd) are Done. Remaining open mirrors Linear (epic [RAD-91](https://linear.app/radiancelux/issue/RAD-91/harden-worktree-ci-exclusive-checkouts-baseref-export-windows-parallel) + post-dogfood board below).

## Where the product stands

The lifecycle is complete: create → review loop (comments, address, resolve, `complete_review`) → `reviewed` → human export/archive. **Orchestration is steward-only:** one `/steward` steward per local PR (`steward_next` / `prgenie steward`) spawns implementor then reviewer Tasks, resumes the same implementor on `changes_requested`, runs the export gate after Reviewer clear, then hands off. Inbox/queue **listen/watch is historical** (RAD-81): `watch start|stop|listen` hard-error to `/steward`; `watch.json` remains only as an export-halt record. CLI and MCP are near feature parity. The extension covers create, status, comments (including edit/delete), threads, editor diffs, worktree switch, export, delete/reopen, complete review, sidebar search, and a read-only archive view.

The gaps are not missing lifecycle pieces — they are **parallel-loop hardening** (exclusive worktrees, worktree CI toolchain, baseRef, export reliability), **dogfood UX**, and **token/context hygiene**. See Remaining open (Linear-backed).

**Pending architecture invariant:** exclusive loop worktrees ([RAD-99](https://linear.app/radiancelux/issue/RAD-99/exclusive-loop-worktrees-refuse-primary-when-another-loop-live)) — refuse binding/creating on the primary checkout when another non-archived loop is live. Today primary reuse is still allowed when the loop branch is already checked out; that is the gap.

---

## Gap analysis

### Gaps for the human

| # | Gap | Evidence |
| --- | --- | --- |
| H1 | ~~No way to see or control watch lanes from the sidebar.~~ **Historical:** inbox/queue Start/Stop shipped, then **removed with the listen flywheel (RAD-81)**. Export-halt diagnostics only. | Was `laneView.ts` + watch APIs; now hard-error to `/steward`. |
| H2 | ~~Sidebar delete/reopen missing.~~ **Done:** CLI/MCP and Local PRs Delete / Reopen. Loop rename via CLI/MCP/sidebar. | `laneView.ts`, `prgenie delete` / `reopen` / `update`. |
| H3 | Stale-install pain: plugin skills, MCP catalog, and the extension all go stale independently. | Mitigated by `prgenie doctor` (hash/version checks + fix text). Humans still must run link-plugin / quit Cursor. |
| H4 | ~~No `complete_review` from the UI.~~ **Done:** Complete review on ready loops (with force on head drift). | `laneView.ts`. |
| H5 | ~~No search or filtering by title/body/comment/file.~~ **Done (RAD-65):** Core+CLI+MCP + Local PRs sidebar search UI. | Core `prs.ts`; CLI/MCP; extension sidebar. |
| H6 | Docs lack an architecture page and a troubleshooting page. README explains the flywheel well but failure modes live in tribal knowledge (partially mirrored by `prgenie doctor` output). | Root `README.md`, `packages/plugin/README.md`. |
| H7 | No `gh` bind management in the UI; export can fail late on the wrong account. | `gh use` is CLI/MCP-only; `github-gate.cjs` enforces at push time. |

### Gaps for the agents

| # | Gap | Evidence |
| --- | --- | --- |
| A1 | ~~Hand-rolled PowerShell listen loops~~ **Historical:** `prgenie watch listen` shipped, then **removed (RAD-81)**. Steward `/steward` is current. | Skills call steward MCP; no listen ticks. |
| A2 | ~~`watch.json` unlocked~~ **Done:** writes go through `withFileLock` via `mutateWatch` (file now export-halt only). | `packages/core/src/watch.ts`. |
| A3 | Corrupt PR JSON is still skipped by `listLocalPrs`, but `listCorruptLocalPrFiles` + `prgenie doctor` name them. `github-gate` outer catch is fail-closed (`ask`) instead of allow. | `prs.ts`, `doctor.ts`, `github-hook.ts`. |
| A4 | ~~No `complete_review` drift signal~~ **Done:** `completeLocalPrReview` refreshes HEAD and returns `headDrift` / `reviewedAgainstSha`. Spawn-once-per-HEAD already existed via `shouldSpawnReviewer` / `markReviewRequested` (core + `review-hook.ts`); hooks are not the sole readers. | `prs.ts`; CLI warns; MCP returns the flags. |
| A5 | ~~MCP ignored core/CLI `--stat`~~ **Done:** MCP `get_diff` accepts `stat` and `paths`. Core `getLocalPrDiff` already had `{ stat }`; CLI had `prgenie diff --stat`. | `mcp.ts`, `review` skill. |
| A6 | ~~`sessions.jsonl` write-only~~ **Done:** `listSessions` + `prgenie sessions` + MCP `list_sessions`. | `sessions.ts`; CLI/MCP. |
| A7 | ~~No comment edit/delete.~~ **Done:** Core + CLI + MCP + sidebar Edit/Delete for open findings. | `editLocalPrComment` / `deleteLocalPrComment`. |
| A8 | ~~Inbox/queue `watch listen` was the only orchestrator.~~ **Done (RAD-70 + RAD-81):** one **steward** per local PR (`/steward`, `steward_next` / `prgenie steward`) owns the lifecycle — spawn implementor Task, then reviewer when ready; on `changes_requested` resume the same `implementorTaskId`; after Reviewer clear run the RAD-71 export gate and only then hand off. Durable `{ loopId, implementorTaskId, reviewerTaskId }` in `.git/agent-console/stewards.json`. Listen flywheel **removed** (RAD-81): no `/watch-inbox` / `/watch-ready`, no sidebar Start/Stop, CLI/MCP `watch start\|stop\|listen` hard-error to `/steward`. | Historical watch fan-out: [rca-windows-dogfood-stability.md](docs/rca-windows-dogfood-stability.md) §A / Slice 1. |

### Platform / quality gaps

| # | Gap | Evidence |
| --- | --- | --- |
| P1 | ~~No CI~~ **Done:** `.github/workflows/ci.yml` runs build, typecheck, test. | Workflow on push/PR to `main`. |
| P2 | Test holes remain for CLI command parsing, MCP tool layer, hooks, and the extension (core + listen/doctor coverage improved). | Mainly `mcp-stdio.test.ts` outside core. |
| P3 | ~~No lint/format config~~ **Done** (PR #13): ESLint + Prettier + CI `lint` / `format:check`. | `eslint.config.mjs`, Prettier, CI. |
| P4 | ~~Version/release process manual / VSIX lag~~ **Done:** one version across root+packages; `pnpm check-versions` + doctor `package-versions`; `pnpm pack:extension`; docs/release.md. VSIX remains gitignored. | `versions.ts`, `scripts/check-versions.mjs`, `scripts/pack-extension.mjs`. |
| P5 | ~~Legacy `push-gate.mjs`~~ **Done:** removed; `doctor` fails if it reappears. | Deleted; superseded by `github-gate.cjs`. |

---

## Roadmap

### Now — operability for the flywheel — **shipped this loop**

1. **`prgenie watch listen` (A1).** ✅ _Historical — listen removed by RAD-81; steward-only is current._
2. **`prgenie doctor` (H3, A3, P5).** ✅
3. **Lock `watch.json` (A2).** ✅
4. **CI (P1).** ✅

### Next — human surface and review quality — **shipped this loop**

5. **Watch panel in the sidebar (H1).** ✅ _Historical UI; listen/watch lanes removed (RAD-81)._
6. **Loop administration (H2).** ✅ CLI/MCP/UI delete + reopen + rename.
7. **Stale-review guard (A4).** ✅
8. **Diff strategy for large loops (A5).** ✅
9. **Comment edit/delete (A7).** ✅
10. **`complete_review` in the UI (H4).** ✅

### Later — scale and polish

11. **History surface (A6).** ✅ CLI+MCP only (no sidebar UI).
12. **Search/filter (H5).** ✅ Core+CLI+MCP + sidebar UI ([RAD-65](https://linear.app/radiancelux/issue/RAD-65/sidebar-searchfilter-for-local-prs-h5-remainder) Done).
13. **Test debt (P2) + lint (P3).** ✅ Lint/format + CLI/MCP/hooks tests (PR #13). Extension UI tests still open under P2 remainder.
14. **Release discipline (P4).** ✅
15. **`gh` bind in the UI (H7).** ✅ RAD-10: `gh` bind management accessible via the UI.
16. **Docs (H6).** ✅ RAD-14: Added architecture.md and troubleshooting.md.
17. **Sidebar rename for loops (H2 remainder).** ✅ RAD-5: Title edits available via `prgenie update` / MCP and sidebar.

---

## Sequencing rationale

The Now items removed the failure modes daily use hit early: hand-rolled listen shells, stale installs, watch races, and missing CI. Next closed review-quality holes and human parity in the sidebar. Steward-per-loop (RAD-70/81) replaced listen orchestration. Current open work is Linear-backed parallel-loop hardening and post-dogfood polish — see Remaining open.

### Learn — memory and shepherd

18. **Repo pattern memory + ready preflight.** ✅ RAD-6: `learnings` track repo patterns; `preflight` validates loops before `ready`.
19. **Sessions → learning digest.** ✅ RAD-9: `prgenie sessions` CLI exposes `sessions.jsonl` history for agent reuse.
20. **Export shepherd gate.** ✅ RAD-11: `shepherd` gate on `/export` validates bind/drift/findings before push.

### Next-Learn — steward-per-loop

21. **Steward-per-local-PR (A8).** ✅ RAD-70: `/steward` + durable `stewards.json` + `steward_next` (export gate before Push to origin). **RAD-81:** listen/watch flywheel removed; `/steward` is the only orchestrator and hard-stops if MCP/`steward_next` is unavailable.
22. **Dogfood polish (RAD-77).** ✅ Comment action colors, short slash names, CI check modal, Open terminal, chat CI progress card, review-cleared copy, implementor preflight + smart/fail-fast CI. See [docs/ci-checks.md](docs/ci-checks.md).

### Shipped — additional control-plane work

- **RAD-27**: `attach` imports GitHub PRs or branches as local loops.
- **RAD-33**: `shepherd` verdict checks all gates (review, preflight, bind, CI).
- **RAD-34**: Local CI gate (format/lint/typecheck/test/build) in shepherd/export validation.
- **RAD-35**: CI cache to speed incremental runs.
- **RAD-36**: Ignore untracked junk in CI diffs.
- **RAD-38**: Reject `attach` on merged PRs.
- **RAD-45**: `version` command and `--help` across CLI.
- **RAD-46**: Windows CRLF and timeout fixes.
- **RAD-49**: Windows-portable test suite.
- **RAD-54**: Stranger-ready README with dogfood path.
- **RAD-25**: `learnings` CLI exposes bare learnings (without full sessions).
- **RAD-65**: H5 sidebar search/filter for Local PRs. **Done.**
- **RAD-71**: Human export / Push to origin gated on shepherd CI green (`exportGate`).
- **RAD-72**: Export CTA renamed to Push to origin, higher-contrast attention, first-enter popup.
- **RAD-77**: Dogfood polish — comment colors, short slash names, CI modal + chat card, Open terminal, review-cleared copy, implementor preflight + smart/fail-fast CI.
- **RAD-81**: `/steward` hard steward-only (stop if MCP/`steward_next` unavailable). Listen/watch flywheel removed.
- **RAD-86**: MCP default cwd to workspace/git root (no silent “not a git repo”). **Done** (cwd piece of [RAD-83](https://linear.app/radiancelux/issue/RAD-83/dogfood-ux-export-emptydraft-layout-loop-rename-mcp-cwd) scope).

### Remaining open

Linear is SoT. Priorities below mirror Linear (`Urgent` / `High` / `Medium`); statuses are Backlog/Todo unless noted. Do not invent ranking beyond epic child order and Linear priority.

#### Epic — harden parallel loops ([RAD-91](https://linear.app/radiancelux/issue/RAD-91/harden-worktree-ci-exclusive-checkouts-baseref-export-windows-parallel)) — High

Children in epic rank order:

1. **[RAD-92](https://linear.app/radiancelux/issue/RAD-92/worktree-ci-toolchain-junctioninstall-bins-before-run-ci)** — Worktree CI toolchain: junction/install bins before `run_ci` (Urgent · Todo)
2. **[RAD-99](https://linear.app/radiancelux/issue/RAD-99/exclusive-loop-worktrees-refuse-primary-when-another-loop-live)** — Exclusive loop worktrees: refuse primary when another loop live (Urgent · Todo) — **pending architecture invariant**
3. **[RAD-94](https://linear.app/radiancelux/issue/RAD-94/enforce-declared-baseref-before-readyciexport-correct-upstream)** — Enforce declared `baseRef` before ready/CI/export + correct upstream (Urgent · Todo)
4. **[RAD-95](https://linear.app/radiancelux/issue/RAD-95/export-reliability-early-bind-atomic-prune-partial-failure-report)** — Export reliability: early bind, atomic prune, partial-failure report (High · Backlog)
5. **[RAD-100](https://linear.app/radiancelux/issue/RAD-100/mcp-timeoutsprogress-for-gitci-tools-windows-cli-docs)** — MCP timeouts/progress for git+CI tools + Windows CLI docs (High · Backlog)
6. **[RAD-97](https://linear.app/radiancelux/issue/RAD-97/ready-requires-ci-or-skip-reason-review-resume-after-auth)** — Ready requires CI (or skip reason); review resume after auth (High · Backlog)

#### Post-dogfood board (related)

- **[RAD-83](https://linear.app/radiancelux/issue/RAD-83/dogfood-ux-export-emptydraft-layout-loop-rename-mcp-cwd)** — Dogfood UX: EXPORT empty/draft layout + `/steward` rename + MCP cwd (Medium · Backlog). **Note:** MCP cwd shipped via [RAD-86](https://linear.app/radiancelux/issue/RAD-86/mcp-default-cwd-to-workspacegit-root-no-silent-not-a-git-repo); EXPORT UX + `/steward` rename remain.
- **[RAD-84](https://linear.app/radiancelux/issue/RAD-84/steward-parallelism-guardrails-concurrency-limit-batching)** — Steward parallelism guardrails (concurrency limit / batching) (Medium · Backlog)
- **[RAD-85](https://linear.app/radiancelux/issue/RAD-85/docs-one-page-human-happy-path-install-loop-export)** — Docs: one-page human happy path (install → `/steward` → export) (Medium · Backlog)
- **[RAD-87](https://linear.app/radiancelux/issue/RAD-87/loop-dependson-base-other-local-pr-head)** — Loop `dependsOn` / base = other local PR head (High · Backlog)
- **[RAD-88](https://linear.app/radiancelux/issue/RAD-88/token-budget-context-hygiene-thin-packets-stuck-task-recover)** — Token budget / context hygiene (thin packets, stuck-Task recover) (High · Backlog)
  - **[RAD-89](https://linear.app/radiancelux/issue/RAD-89/asymmetric-model-tiers-cheap-implementor-strong-reviewer)** — Asymmetric model tiers: cheap implementor / strong reviewer (High · Backlog; child of RAD-88)
- **[RAD-103](https://linear.app/radiancelux/issue/RAD-103/reviewer-skill-adopt-generic-highmedium-bar-impactregressiontest)** — Reviewer skill: generic HIGH/MEDIUM bar + impact/regression/test checks (High · Todo)
- **[RAD-102](https://linear.app/radiancelux/issue/RAD-102/ingest-repo-specific-review-guidance-into-reviewer-task-packets)** — Ingest repo-specific review guidance into reviewer Task packets (High · Backlog; after RAD-103)

#### Parked / other owners

- **[RAD-68](https://linear.app/radiancelux/issue/RAD-68/slice-2-verified-complete-review-held)** — Slice 2: verified `complete_review` — **parked / held** until greenlight (Medium · Backlog)
- **[RAD-76](https://linear.app/radiancelux/issue/RAD-76/mvp-distribution-github-release-marketplacenpm-cos-owned)** — MVP distribution: GitHub Release → marketplace/npm — **CoS-owned** (High · Backlog; not PM flywheel)
