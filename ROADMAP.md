# PR Genie — Gap analysis and roadmap

Grounded in a full survey of the code as of `main` (post PR #5): `packages/core`, `packages/cli`, `packages/plugin`, `packages/extension`, the skills/rules/hooks, and the flywheel workflow (implementor chat ↔ reviewer chat ↔ human). Each item names the gap, why it matters, and where the change lands. Ordered by priority within each horizon.

## Where the product stands

The lifecycle is complete: create → review loop (comments, address, resolve, `complete_review`) → `reviewed` → human export/archive. Watch has independent inbox/queue lanes with per-lane stop/start. CLI and MCP are near feature parity. The extension covers create, status, comments, threads, editor diffs, worktree switch, export, and a read-only archive view. Core has strong tests (46) including locking and watch lanes.

The gaps are not missing lifecycle pieces — they are **operability** (recovering when something is stale, stuck, or corrupt), **observability** (what happened and why), and **hardening** (the places that fail silently or fail open).

---

## Gap analysis

### Gaps for the human

| # | Gap | Evidence |
| --- | --- | --- |
| H1 | No way to see or control watch lanes from the sidebar. When a listen loop dies or a lane is halted, the human must run CLI commands to diagnose. | Extension has no watch UI; `watch_status`/`watch_start`/`watch_stop` are CLI/MCP-only. |
| H2 | No delete, rename, or reopen for loops. A mistaken packet lives forever; a wrongly archived loop cannot come back (`setLocalPrStatus` throws on leaving `approved`). | `packages/core/src/prs.ts`; no CLI/MCP/UI surface. |
| H3 | Stale-install pain is the top recurring failure: plugin skills, MCP catalog, and the extension all go stale independently, with three different refresh rituals (re-enable plugin, restart MCP, quit Cursor fully). Nothing detects the skew. | Version skew today: root/cli/core `0.1.0` vs plugin/extension `0.1.1` vs `prgenie-0.1.0.vsix`. MCP catalog staleness is documented in `no-remote-pr.mdc` as a workaround, not fixed. |
| H4 | No `complete_review` from the UI. A human reviewing in the sidebar can file comments (which set `changes_requested` immediately) but cannot run the reviewer's batched flow. | `laneView.ts` has no complete-review action. |
| H5 | No search or filtering. `list --all` and Show archived are the only views; no filter by title, file, or comment text. Fine at 7 loops, not at 70. | `listLocalPrs` has status/inbox filters only. |
| H6 | Docs lack an architecture page and a troubleshooting page. README explains the flywheel well but the failure modes (stale MCP, orphaned `.loops` worktree, lock timeout, corrupt PR JSON) live in tribal knowledge. | Root `README.md`, `packages/plugin/README.md`. |
| H7 | No `gh` bind management in the UI; export can fail late on the wrong account. | `gh use` is CLI/MCP-only; `github-gate.cjs` enforces at push time. |

### Gaps for the agents

| # | Gap | Evidence |
| --- | --- | --- |
| A1 | Listen loops are hand-rolled PowerShell sleep loops pasted from skills. They are the most fragile part of the flywheel: shells get killed, DONE lines vary, cross-platform (bash/cloud) is a re-derivation each time. A built-in `prgenie watch listen <lane> [--ticks 60] [--interval 60]` that prints the TICK/DONE sentinels would make every skill loop identical, capped, and testable. | `watch-review-inbox` / `watch-ready-prs` SKILL.md snippets; this session alone had loops with the wrong DONE prompt and an aborted shell. |
| A2 | `watch.json` writes have no file lock (PR files use `withFileLock`). Two lanes halting/resuming concurrently — exactly what per-lane stop/start now encourages — can lose a write. | `packages/core/src/watch.ts` vs `store.ts`. |
| A3 | Corrupt PR JSON is silently skipped by `listLocalPrs`; a loop can vanish from every list with no signal. Similarly `github-gate.cjs` fails open on unexpected errors. | Silent catch in list; broad catches in hooks. |
| A4 | No stale-review detection. `reviewRequestedSha` is stored but only hooks read it; nothing tells the reviewer "head moved since you reviewed" or blocks a `complete_review` against an old SHA. | `packages/core/src/types.ts`, hooks only. |
| A5 | MCP `get_diff` truncates at 80 KB with no paging and no `--stat` equivalent, so a reviewer agent on a large loop gets a cliff instead of a strategy (stat first, then per-file diff). | `packages/cli/src/mcp.ts`. |
| A6 | `sessions.jsonl` is write-only. There is no `prgenie sessions`/history surface, so neither agents nor the human can answer "what ran against this loop and when" without reading raw JSONL. | `packages/core/src/sessions.ts`. |
| A7 | No comment edit/delete. A reviewer typo or an agent's wrong `--path` is permanent noise in the thread the implementor must address. | Comment model in `types.ts`. |

### Platform / quality gaps

| # | Gap | Evidence |
| --- | --- | --- |
| P1 | No CI. `pnpm test` + `pnpm typecheck` exist but nothing runs them on a branch; an agent-driven repo especially needs a machine gate before review. | No `.github/workflows`. |
| P2 | Test holes: zero tests for CLI command parsing/output, the MCP tool layer above stdio framing, hooks, and the extension. The lane view's read-only-archive contract is enforced only by review. | Only `mcp-stdio.test.ts` outside core. |
| P3 | No lint/format config; style consistency depends on the agents. | No ESLint/Prettier. |
| P4 | Version/release process is manual and already skewed; the checked-in VSIX lags the source. | `0.1.0` vs `0.1.1` vs `prgenie-0.1.0.vsix`. |
| P5 | Legacy dead code: `push-gate.mjs` is shipped in the plugin but not registered in `hooks.json` (superseded by `github-gate.cjs`). | `packages/plugin/hooks/`. |

---

## Roadmap

### Now — operability for the flywheel (next 1–2 loops)

1. **`prgenie watch listen` (A1).** Built-in capped listener: `prgenie watch listen inbox --ticks 60 --interval 60` prints `AGENT_LOOP_TICK_…`/`AGENT_LOOP_DONE_…` sentinels, exits on its lane's halt, and works the same on Windows/bash/cloud. Update `watch-review-inbox`, `watch-ready-prs`, and the loop snippets in `no-remote-pr.mdc` to use it. Acceptance: both skills contain no hand-rolled `for`/sleep loop; a halt mid-listen ends the process within one interval.
2. **`prgenie doctor` (H3, A3, P5).** One command that reports: installed plugin vs repo build hash, extension version vs source, MCP server reachability, watch lane state, corrupt/unparsable PR files (named, not skipped), orphaned `.loops` worktrees, `gh` bind status, and unregistered legacy hooks. Acceptance: every stale-install ritual in the READMEs is detectable by `doctor` with the fix printed.
3. **Lock `watch.json` (A2).** Route watch writes through `withFileLock` like PR files. Acceptance: a concurrency test in `watch.test.ts` (parallel one-sided stop + start) never loses a lane.
4. **CI (P1).** A workflow running `pnpm build`, `pnpm typecheck`, `pnpm test` on push/PR. Acceptance: green run on `main`.

### Next — human surface and review quality

5. **Watch panel in the sidebar (H1).** Show both lanes (listening / halted reason / export id) in the Local PRs view with per-lane start/stop buttons; refresh off the existing `fs.watch` on `.git/agent-console`. Acceptance: a halted lane is visible without the CLI, and the human can resume it in one click.
6. **Loop administration (H2).** `prgenie delete <id>` (with confirm; removes JSON, refs, notes, worktree) and `prgenie reopen <id>` (archived → `changes_requested`, recreating the worktree). Surface both in the UI, gated behind the archived view. Acceptance: a deleted loop leaves no refs/worktree residue; a reopened loop round-trips through review again.
7. **Stale-review guard (A4).** `complete_review` warns (MCP: returns a flag; CLI: prints) when `headSha` ≠ `reviewRequestedSha`; the reviewer skill re-diffs instead of resolving blind. Acceptance: pushing a commit after Review requested makes the next `complete_review` attempt surface the drift.
8. **Diff strategy for large loops (A5).** Add `stat: true` to MCP `get_diff` and a `paths: []` filter for per-file diffs; teach `review-local-pr` to stat first when the full diff would truncate. Acceptance: an 80 KB+ loop is reviewable file-by-file without ever hitting the truncation cliff.
9. **Comment edit/delete (A7).** `prgenie comment-edit` / `comment-delete` (author-or-human only, open comments only) plus UI affordances. Acceptance: a mistaken finding can be corrected without an address/resolve dance.
10. **`complete_review` in the UI (H4)** so the human can act as the reviewer end-to-end from the sidebar.

### Later — scale and polish

11. **History surface (A6).** `prgenie sessions [<id>]` rendering `sessions.jsonl` (and comment timestamps) as a per-loop timeline; optionally a Timeline tab in the panel.
12. **Search/filter (H5).** `prgenie list --grep <text>` over title/body/comments and a filter box in the sidebar.
13. **Test debt (P2) + lint (P3).** CLI command tests (spawn `prgenie.cjs` against a temp repo), MCP tool-layer tests, a hook test for `github-gate` (fail-closed on parse errors — flipping A3's fail-open), and ESLint/Prettier wired into CI.
14. **Release discipline (P4).** Single-version policy across packages, a `pnpm package` script that rebuilds the VSIX, and a versioned CHANGELOG; `doctor` (item 2) flags skew in the meantime.
15. **`gh` bind in the UI (H7)** and an export preflight that shows the bound account before pushing.
16. **Docs (H6).** `docs/architecture.md` (storage layout, status machine, watch lanes, hook wiring) and `docs/troubleshooting.md` seeded from `doctor`'s checks.

---

## Sequencing rationale

The Now items are chosen because they remove the failure modes this project actually hits in daily use: hand-rolled listen shells (A1) and stale installs (H3) have both burned real sessions, the watch race (A2) is newly likely now that lanes stop/start independently, and CI (P1) protects everything that follows. The Next tier makes the human a first-class operator (watch panel, loop admin, reviewer parity) and closes the review-quality holes agents feel (stale reviews, diff cliffs). Later items are valuable but only hurt at higher loop volume.
