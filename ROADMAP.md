# PR Genie — Gap analysis and roadmap

Grounded in a full survey of the code as of `main` (post PR #5): `packages/core`, `packages/cli`, `packages/plugin`, `packages/extension`, the skills/rules/hooks, and the flywheel workflow (implementor chat ↔ reviewer chat ↔ human). Each item names the gap, why it matters, and where the change lands. Ordered by priority within each horizon.

**Status:** Now items 1–4 and Next items 6–8 are implemented on this branch (`prgenie watch listen`, `prgenie doctor`, locked `watch.json`, CI, delete/reopen, `complete_review` headDrift, MCP `get_diff` stat/paths). Remaining Next/Later items stay open.

## Where the product stands

The lifecycle is complete: create → review loop (comments, address, resolve, `complete_review`) → `reviewed` → human export/archive. Watch has independent inbox/queue lanes with per-lane stop/start. CLI and MCP are near feature parity. The extension covers create, status, comments, threads, editor diffs, worktree switch, export, and a read-only archive view. The automated test suite has 46+ cases (core + CLI stdio framing).

The gaps are not missing lifecycle pieces — they are **operability** (recovering when something is stale, stuck, or corrupt), **observability** (what happened and why), and **hardening** (the places that fail silently or fail open).

---

## Gap analysis

### Gaps for the human

| # | Gap | Evidence |
| --- | --- | --- |
| H1 | No way to see or control watch lanes from the sidebar. When a listen loop dies or a lane is halted, the human must run CLI commands to diagnose. | Extension has no watch UI; `watch_status`/`watch_start`/`watch_stop` are CLI/MCP-only. |
| H2 | No rename for loops. Delete/reopen now exist (`prgenie delete` / `prgenie reopen`, MCP `delete_local_pr` / `reopen_local_pr`); sidebar affordances still missing. | CLI/MCP present; `laneView.ts` has no delete/reopen actions. |
| H3 | Stale-install pain: plugin skills, MCP catalog, and the extension all go stale independently. | Mitigated by `prgenie doctor` (hash/version checks + fix text). Humans still must run link-plugin / quit Cursor. |
| H4 | No `complete_review` from the UI. A human reviewing in the sidebar can file comments (which set `changes_requested` immediately) but cannot run the reviewer's batched flow. | `laneView.ts` has no complete-review action. |
| H5 | No search or filtering by title/body/comment/file. Status / inbox / `--all` filtering lives in the CLI (`prgenie list`/`queue`/`inbox`) and MCP `list_local_prs` — not in `listLocalPrs` itself (which returns every packet). | CLI/MCP list surfaces; `listLocalPrs` is unfiltered. |
| H6 | Docs lack an architecture page and a troubleshooting page. README explains the flywheel well but failure modes live in tribal knowledge (partially mirrored by `prgenie doctor` output). | Root `README.md`, `packages/plugin/README.md`. |
| H7 | No `gh` bind management in the UI; export can fail late on the wrong account. | `gh use` is CLI/MCP-only; `github-gate.cjs` enforces at push time. |

### Gaps for the agents

| # | Gap | Evidence |
| --- | --- | --- |
| A1 | ~~Hand-rolled PowerShell listen loops~~ **Done:** `prgenie watch listen inbox\|queue`. | Skills now call the CLI; no skill-local `for`/`Start-Sleep` loops. |
| A2 | ~~`watch.json` unlocked~~ **Done:** writes go through `withFileLock` via `mutateWatch`. | `packages/core/src/watch.ts`. |
| A3 | Corrupt PR JSON is still skipped by `listLocalPrs`, but `listCorruptLocalPrFiles` + `prgenie doctor` name them. `github-gate` outer catch is fail-closed (`ask`) instead of allow. | `prs.ts`, `doctor.ts`, `github-hook.ts`. |
| A4 | ~~No `complete_review` drift signal~~ **Done:** `completeLocalPrReview` refreshes HEAD and returns `headDrift` / `reviewedAgainstSha`. Spawn-once-per-HEAD already existed via `shouldSpawnReviewer` / `markReviewRequested` (core + `review-hook.ts`); hooks are not the sole readers. | `prs.ts`; CLI warns; MCP returns the flags. |
| A5 | ~~MCP ignored core/CLI `--stat`~~ **Done:** MCP `get_diff` accepts `stat` and `paths`. Core `getLocalPrDiff` already had `{ stat }`; CLI had `prgenie diff --stat`. | `mcp.ts`, `review-local-pr` skill. |
| A6 | `sessions.jsonl` is write-only. There is no `prgenie sessions`/history surface. | `packages/core/src/sessions.ts`. |
| A7 | No comment edit/delete. A reviewer typo or an agent's wrong `--path` is permanent noise. | Comment model in `types.ts`. |

### Platform / quality gaps

| # | Gap | Evidence |
| --- | --- | --- |
| P1 | ~~No CI~~ **Done:** `.github/workflows/ci.yml` runs build, typecheck, test. | Workflow on push/PR to `main`. |
| P2 | Test holes remain for CLI command parsing, MCP tool layer, hooks, and the extension (core + listen/doctor coverage improved). | Mainly `mcp-stdio.test.ts` outside core. |
| P3 | No lint/format config; style consistency depends on the agents. | No ESLint/Prettier. |
| P4 | Version/release process is manual and already skewed; the checked-in VSIX lags the source. `doctor` flags extension version skew. | `0.1.0` vs `0.1.1` vs `prgenie-0.1.0.vsix`. |
| P5 | ~~Legacy `push-gate.mjs`~~ **Done:** removed; `doctor` fails if it reappears. | Deleted; superseded by `github-gate.cjs`. |

---

## Roadmap

### Now — operability for the flywheel — **shipped this loop**

1. **`prgenie watch listen` (A1).** ✅
2. **`prgenie doctor` (H3, A3, P5).** ✅
3. **Lock `watch.json` (A2).** ✅
4. **CI (P1).** ✅

### Next — human surface and review quality

5. **Watch panel in the sidebar (H1).** Still open.
6. **Loop administration (H2).** ✅ CLI/MCP delete + reopen; UI still open.
7. **Stale-review guard (A4).** ✅
8. **Diff strategy for large loops (A5).** ✅
9. **Comment edit/delete (A7).** Still open.
10. **`complete_review` in the UI (H4).** Still open.

### Later — scale and polish

11. **History surface (A6).**
12. **Search/filter (H5).**
13. **Test debt (P2) + lint (P3).**
14. **Release discipline (P4).**
15. **`gh` bind in the UI (H7).**
16. **Docs (H6).**

---

## Sequencing rationale

The Now items remove the failure modes daily use actually hits: hand-rolled listen shells, stale installs, watch races under per-lane stop/start, and missing CI. Next closes review-quality holes agents feel and finishes human parity in the sidebar. Later items hurt mainly at higher loop volume.
