# RCA: Windows dogfood stability (Brett Humphreys)

**Status:** Historical analysis. Inbox/queue listen was **removed in RAD-81** — `/loop` is the only orchestrator. Keep this page as RCA, not as a dogfood path.

**Audience:** PM + next CloudAgent implement slices.
**Scope:** Windows MVP dogfood against `radiancelux/prgenie` checkout
`C:\Users\BrettHumphreys\Documents\GitHub\pr-genie` (loops `lp-9ff837d2`, draft `lp-15976a74`).
**CLI used:** `node packages\cli\dist\prgenie.cjs` (not on PATH).

Flows 1–4 passed (install/doctor, gh bind, `/start` create, review flywheel via CLI).
Flow 5 shepherd stopped (appeared hung). Flows 6–8 not run.

---

## 1. Cascade (timeline / dependency graph)

```text
Install friction (PATH, VSIX vs folder copy, plugin file locks)
        │
        ▼
/watch-ready (+ optional inbox) starts `watch listen`
        │  TICK every 60s, no code-level cap
        ▼
Each TICK wakes the parent agent → new shells / Task subagents
        │  ~1 background task per minute if the agent re-spawns work
        ▼
Extension host 2s poller: pushSnapshot → shepherdStatus → runCiChecks
        │  no in-flight mutex; first paint waits on this
        │  cache.json write retriggers fs.watch → more overlapping CI
        ▼
Machine lag + many cmd.exe + "Extension host became UNRESPONSIVE"
        │
        ├── sidebar webview never gets a snapshot (empty UI, refresh no-op)
        ├── reviewer Tasks report "done" without packet flip
        └── `prgenie shepherd` looks hung (same CI path, 5 min/check)
```

**Approximate dogfood timeline (inferred, not a recorded trace):**

| T   | What happens                                                                                                                                                                                                   | Why it looks like the next symptom                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| T0  | `pnpm link-extension` / plugin copy while Cursor is open; CLI never lands on PATH                                                                                                                              | Doctor can still be green (filesystem checks only)                                       |
| T1  | `/watch-ready` arms `watch listen queue --interval 60` with Cursor **Notify on** `AGENT_LOOP_TICK_review-queue`                                                                                            | One cheap Node sleeper; expensive part is the agent wake                                 |
| T2  | Every 60s the listen process prints a TICK **even if the queue did not change**                                                                                                                                | Parent chat gets a new turn every minute                                                 |
| T3  | Each turn may spawn `watch queue`, `/queue`, and a `generalPurpose` Task. Prompt says "don't duplicate"; nothing enforces it. Implementor `stop` hook can spawn a **second** reviewer for the same HEAD | ~27 background tasks ≈ ~27 minutes of listen                                             |
| T4  | Local PRs webview activates. `LaneHub` polls every 2s and, for a selected loop, calls `shepherdStatus()` which runs **full local CI** (format/lint/typecheck/test/build) unless cache hits                     | First snapshot is blocked for minutes; overlapping polls stack more `pnpm` / `cmd.exe`   |
| T5  | `checkFormatFromBlobs` shells `git show \| pnpm exec prettier` **once per tracked file** (~102 prettier-eligible files in this repo)                                                                           | "Many cmd.exe children" without any watch skill                                          |
| T6  | CI cache write under `.git/agent-console/` fires recursive `fs.watch` → another `pushSnapshot` with no single-flight                                                                                           | Feedback loop while the first CI is still running                                        |
| T7  | Extension host misses its heartbeat → `Extension host became UNRESPONSIVE`. Webview stays on initial HTML (empty list, hidden gh-bind, blank panel). Refresh posts a message nobody handles                    | Sidebar empty **while CLI `list` / `gh status` still work**                              |
| T8  | Reviewer Task claims "Review complete" (comment and/or Task summary). `complete_review` never lands (PATH, MCP missing in Task, head-drift throw, no post-condition check)                                     | Packet stays `ready`; human uses CLI `complete-review`                                   |
| T9  | Flow 5 `prgenie shepherd <id>` runs the **same** `runCiChecks` with 5 min timeout **per** check, on a lagged machine                                                                                           | Looks hung; may actually be working                                                      |
| T10 | User kills Cursor background tasks → lag clears. Host/webview may stay dead until full Cursor quit                                                                                                             | Confirms Tasks were a major CPU hog; does not prove the sidebar bug is _only_ host death |

---

## 2. Root causes vs symptoms

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                       | Class                                                                                                                       | Confidence                                                         | Evidence                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Watch **TICK wakes are uncapped**. Listen itself is one process; Cursor + skills treat every 60s TICK as a new agent turn that may spawn shells/Tasks. Dedup is prompt-only ("remember `id`+`headSha` this session").                                                                                                                                                                                         | **Root** (lag / 27 tasks)                                                                                                   | High                                                               | `listenWatchLane` always `write(TICK)` after each interval (`packages/core/src/watch.ts`). Skills: `watch-ready`, `queue`. CLI `--interval` is **seconds** (`packages/cli/src/cli.ts`).                                                                                                                                             |
| R2  | **Implementor `stop` hook also Tasks a reviewer** for the same ready HEAD (`shouldSpawnReviewer` / `formatSpawnReviewer`), independent of the reviewer chat queue.                                                                                                                                                                                                                                            | **Root** (duplicate reviewers)                                                                                              | High                                                               | `packages/cli/src/review-hook.ts` `event === "stop"`; `hooks.json` `stop` + `subagentStop`.                                                                                                                                                                                                                                                    |
| R3  | Sidebar `pushSnapshot` **blocks first paint on `shepherdStatus` → `runCiChecks`**, every 2s, **no in-flight guard**. Cache writes re-enter via `fs.watch`.                                                                                                                                                                                                                                                    | **Root** (host death, empty UI, stacked CI, shepherd "hang")                                                                | High                                                               | `LaneHub` constructor `setInterval(..., 2000)`; `pushSnapshot` awaits `shepherdStatus` before `post()` (`packages/extension/src/laneView.ts`). `shepherdStatus` always runs CI unless `skipCiCheck` (`packages/core/src/shepherd.ts`). `runCiChecks` default timeout **300s per check**, per-file prettier (`packages/core/src/ci-runner.ts`). |
| R4  | Review complete is **prompt-gated, not state-gated**. Leaf may lack MCP; Windows fallback is `prgenie` which is **not on PATH**. Parent is told not to wait and not to `complete_review`. Head-drift **throws** before status flip. "Review complete" text is also the default comment body _inside_ a successful `completeLocalPrReview` — agents can mimic it via `add_comment` while status stays `ready`. | **Root** (flaky review)                                                                                                     | High                                                               | Skills `review` / `queue`; `completeLocalPrReview` (`packages/core/src/prs.ts`); CLI `bin` only in `packages/cli/package.json`, never globally linked.                                                                                                                                                                         |
| R5  | Windows install/docs assume **folder copy + Unix PATH**. `link-extension` is a copy into `~\.cursor\extensions`; doctor only checks **disk version**, not that Cursor loaded the extension. Plugin uninstall wiping `~\.cursor\plugins\local\prgenie` is expected Cursor behavior; relink while Cursor holds `server.cjs` needs a full quit on Windows.                                                       | **Root** (install friction)                                                                                                 | High (docs/process); Medium (why VSIX was required)                | `scripts/link-extension.ps1`, `scripts/link-plugin.ps1`, `docs/release.md` ("You do **not** need a VSIX"), `doctor.ts` extension check.                                                                                                                                                                                                        |
| R6  | Test harness still has **Unix-only** bits after RAD-49. CI is `ubuntu-latest` only.                                                                                                                                                                                                                                                                                                                           | **Root** (4 Windows test fails)                                                                                             | High                                                               | `attach.test.ts` `chmod` + bash `gh` stub; `ci-runner.test.ts` RAD-46 uses `ln -s` and `sleep N` (cmd.exe has no `sleep`).                                                                                                                                                                                                                     |
| S1  | ~27 Cursor background tasks + many `cmd.exe`                                                                                                                                                                                                                                                                                                                                                                  | **Symptom** of R1 (and R3 prettier/pnpm children)                                                                           | High                                                               | Matches 60s ticks × ~27 min; plus ~102 prettier shells on a CI miss.                                                                                                                                                                                                                                                                           |
| S2  | Extension host UNRESPONSIVE                                                                                                                                                                                                                                                                                                                                                                                   | **Symptom** of R1+R3 starving the host                                                                                      | High                                                               | Console message; lag cleared when Tasks were killed.                                                                                                                                                                                                                                                                                           |
| S3  | Local PRs sidebar empty, refresh no-op, doctor green, CLI list works                                                                                                                                                                                                                                                                                                                                          | **Mostly symptom** of S2/R3 (webview never posted). **Possible independent** empty-accounts / error-path issues — see §2.1. | High for host-death path; Medium for a remaining bind/snapshot bug | Initial HTML hides watch + gh-bind and leaves `#list` empty until a snapshot arrives. `refresh` is `postMessage` into the same host. Doctor does not talk to the webview.                                                                                                                                                                      |
| S4  | Shepherd "hung" in Flow 5                                                                                                                                                                                                                                                                                                                                                                                     | **Symptom** of R3 design: CLI shepherd **is** local CI, up to ~25 min, worse under lag                                      | High                                                               | `prgenie shepherd` → `shepherdStatus` with CI on (`packages/cli/src/cli.ts`).                                                                                                                                                                                                                                                                  |
| S5  | Duplicate "Review complete" comments, packet still `ready`                                                                                                                                                                                                                                                                                                                                                    | **Symptom** of R2+R4                                                                                                        | High                                                               | `completeLocalPrReview` is the only writer of status `reviewed`/`changes_requested` from a reviewer pass; if status stayed `ready`, that call did not succeed.                                                                                                                                                                                 |

### 2.1 Hypothesis check

| Hypothesis                                                                                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Watch listeners spawn unbounded shell/agent tasks without caps → host starvation → empty sidebar as a _symptom_ of host death | **Confirmed.** Listen process is capped (30m idle / 8h wall). The **agent reaction to TICK** is not. Empty sidebar is the expected webview state until the first `post()`.                                                                                                                                                                                                                                                                                                                                                                       |
| Sidebar also has an independent snapshot/bind bug when the host is healthy                                                    | **Not disproven.** Two real code smells remain: (1) first `post()` waits on CI; a healthy host still shows empty UI for minutes; (2) outer `catch` in `pushSnapshot` posts `prs: []`, wiping a previously good list. `spawn("gh")` without `shell` can fail to see `gh.cmd` under Cursor's Windows PATH even when a user terminal `gh status` works — that would empty the **dropdown**, not the loop list. **Do not treat "fix bind spawn" as the empty-list fix.** Re-test sidebar with R3 fixed and Tasks stopped before more UI archaeology. |
| Install/docs assume Unix PATH + folder link; Windows needs VSIX-first                                                         | **Mostly confirmed.** Docs explicitly say VSIX is optional. Dogfood needed `pack:extension` + `cursor --install-extension`. Likely mix of "Cursor didn't rescan unpacked copy until full quit" and Windows file locks. Doctor stays green either way.                                                                                                                                                                                                                                                                                            |
| Test harness uses Unix-only APIs on Windows                                                                                   | **Confirmed** for the four named failures. RAD-49's `linkNodeModules` helper was **not** used in the RAD-46 CRLF test.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Review complete gate races or doesn't wait for MCP/skill state                                                                | **Confirmed as a process/prompt hole, not a core race on the JSON lock.** `withFileLock` serializes writers. The leaf is not required to re-`show` the packet; the parent is forbidden from completing or awaiting. Drift throw + missing Windows CLI are sufficient.                                                                                                                                                                                                                                                                            |

---

## 3. Fix order (CloudAgent slices)

Ship **in this order**. Each slice is independently mergeable. Do not combine R1+R3+R4 into one PR.

### Slice 0 — P0: Stop running local CI on the sidebar poller

**Why first:** This is the extension-host footgun. It makes every other investigation noisy.

**Change (minimal):**

- `pushSnapshot` must **not** `await shepherdStatus()` (and therefore `runCiChecks`) on the 2s timer or on `fs.watch`.
- Post the loop list / watch / gh-bind **immediately**.
- Optional: compute a **cheap** shepherd (review + bind + preflight, `skipCiCheck: true`) off the hot path, debounce ≥30s, single-flight.
- Add an **in-flight mutex** so overlapping `pushSnapshot` calls collapse to one.
- Do not block first paint on `archiveLoopsMergedOnGithub` either (already 30s gated; still `gh pr view` per live loop).

**Out of this slice:** changing CLI `prgenie shepherd` semantics; rewriting CI cache; watch skills.

**Acceptance criteria:**

- [ ] Opening Local PRs paints loops from `.git/agent-console/prs` within a short bound (target: **<2s** on a warm git dir) even if CI has never passed.
- [ ] With the sidebar open for 2 minutes and no user action, Process Explorer / Task Manager does **not** show repeated `pnpm test` / `pnpm build` / per-file prettier from the Cursor extension host.
- [ ] Concurrent `fs.watch` + poll ticks do not start a second snapshot until the first finishes.
- [ ] CLI `prgenie shepherd <id>` still runs full CI (that is Slice 5 / product, not this PR).
- [ ] Existing extension behavior for list/select/comment/export unchanged aside from shepherd widget freshness.

### Slice 1 — P0: Cap watch-listen fan-out

**Why:** Matches the 27-task scorecard. Skills today _intend_ one listen process; Cursor Notify-on-TICK fights that.

**Change:**

- Emit TICK only when **queue/inbox fingerprint changed** or halt/idle/max, **or** add `--notify-on-change` default for skills.
- Persist dispatched `id`+`headSha` in `.git/agent-console/` (not chat memory). `queue` / MCP skip if already dispatched and still `ready`.
- Hard cap: at most **one** in-flight reviewer Task per loop HEAD (core or MCP `claim_review`).
- Skills: one background listen shell; TICK handler must **not** start another listen; must **not** Task if a claim exists.
- Optional: raise default interval for agent-wake (e.g. 3–5 min) if TICK still wakes the model.

**Acceptance criteria:**

- [ ] A 30-minute idle listen on an unchanged queue produces **0** reviewer Tasks and **1** listen process.
- [ ] Two ready loops → at most two reviewer claims; a second `/queue` pass does not spawn duplicates.
- [ ] Windows dogfood: Cursor Background Agents panel does not accumulate ~1 task/minute.
- [ ] `/stop-review` still kills the lane; idle/max DONE still halt as today.

### Slice 2 — P0: Review complete is a verified state transition

**Why:** CLI flywheel worked; Task flywheel did not. Humans should not `complete-review` by hand.

**Change:**

- Leaf skill: after `complete_review`, **must** `get_local_pr` / `prgenie show` and confirm `status` is `changes_requested` or `reviewed`. If still `ready`, report failure (include stderr / drift message). Do not say "Review complete" as a free `add_comment`.
- Windows-safe CLI in every reviewer skill: `node packages/cli/dist/prgenie.cjs complete-review <id>` (same pattern as listen).
- Parent `/queue`: do not wait, but on later TICK if `id`+`headSha` still `ready` after claim TTL (e.g. 15 min), surface "reviewer did not flip packet" instead of spawning a duplicate by default (or spawn **one** retry, claimed).
- Keep head-drift as a hard fail (good); make the error the Task's last line.

**Acceptance criteria:**

- [ ] A reviewer Task that only `add_comment`s "Review complete" leaves status `ready` **and** the parent does not treat it as done.
- [ ] A reviewer Task that successfully calls complete (no drift) leaves status `reviewed` or `changes_requested` without a human CLI step.
- [ ] Drift: Task stderr/output contains the existing HEAD-moved message; packet stays `ready`.
- [ ] No change to comment lock / learning extraction behavior on the success path.

### Slice 3 — P1: Dedup implementor-hook vs reviewer-chat spawn

**Why:** R2 doubles Slice 1's fan-out even after TICK caps.

**Change:** Pick one dispatcher:

- **Preferred:** reviewer chat / `claim_review` is the only spawner. Implementor `stop` hook should **not** `followup_message` a Task-reviewer if a queue listen is active (or at all).
- Or: hook sets `reviewerNotifiedSha` only; watch queue is the sole Tasker.

**Acceptance criteria:**

- [ ] Marking a loop `ready` with `/watch-ready` already running spawns **exactly one** reviewer claim, not hook+queue.
- [ ] No reviewer chat still gets a single spawn from the hook (document which).

### Slice 4 — P1: Windows install is VSIX + explicit CLI, doctor tells the truth

**Change:**

- README / `docs/release.md` / troubleshooting: **Windows Cursor: `pnpm pack:extension` then `cursor --install-extension packages\extension\prgenie-<ver>.vsix`**, then full quit. `link-extension` is "may work after full quit; if Local PRs is missing, use VSIX."
- `link-plugin` / `link-extension` scripts: fail clearly if dest files are locked; print "quit Cursor and retry."
- Document CLI: `pnpm cli` or `node packages/cli/dist/prgenie.cjs`. Optional `pnpm.cmd` helper / `pnpm setup-cli` that prints a user-PATH snippet (do not require admin global npm).
- Doctor: `extension` check stays version-on-disk; add a note that a loaded webview is not verified. Optional: doctor warns if `prgenie` is not resolvable on PATH (informational, not FAIL).

**Acceptance criteria:**

- [ ] A new Windows checkout can follow README only and get a **visible, populated** Local PRs view after install (manual AC).
- [ ] Uninstall plugin → relink instructions mention full Cursor quit.
- [ ] Docs no longer say VSIX is unnecessary on Windows without the full-quit caveat.

### Slice 5 — P1: Shepherd UX (CLI looks hung because it _is_ CI)

**Change (after Slice 0):**

- `prgenie shepherd` prints each check as it starts/finishes (`format:check…`, `lint…`) and that default timeout is 5 min/check.
- Reuse CI cache (already RAD-35); do not skip it.
- Sidebar shepherd widget: cached/cheap gates live; CI result is last-known from cache or a **manual Refresh CI** action, never a 2s poll.

**Acceptance criteria:**

- [ ] Flow 5 on Windows shows streaming progress within a few seconds of invoke.
- [ ] A cache-hot shepherd returns in seconds, not minutes.
- [ ] Sidebar does not start a new full CI suite to paint the export widget.

### Slice 6 — P2: Windows-portable tests (finish RAD-49)

**Change:**

- `attach.test.ts`: replace `chmod` + bash `gh` stub with a `gh.cmd` / `gh.bat` on PATH (or `spawn` mock). No `chmod` binary.
- RAD-46 CRLF test: use existing `linkNodeModules` (junction on win32), not `ln -s`.
- Timeout tests: do not call `sleep` (missing on cmd.exe). Use `node -e "setTimeout(()=>{}, 3000)"` or a tiny JS sleeper.
- Temp `rm`: retry on `EBUSY`/`EPERM` (Windows), or skip `after` throw.
- CI: add a `windows-latest` test job **or** document that Ubuntu CI cannot catch these. Prefer a Windows job once tests are portable.

**Acceptance criteria:**

- [ ] `pnpm test` on Windows: 0 fails from chmod / ln / sleep / EBUSY cleanup.
- [ ] RAD-46 CRLF assertion still proves blob-LF vs worktree-CRLF (the product fix stays).
- [ ] Linux CI stays green.

---

## 4. Do **not** fix yet

| Item                                                                        | Why defer                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Unbounded skill rewrite into a native Cursor subscription / MCP resource    | Product/platform; Slice 1 is the small cap.                                                                           |
| Making `complete_review` ignore head drift                                  | Safety feature; fix the agent around it (Slice 2).                                                                    |
| Running CI in the extension host "but cached" as the sidebar design         | Cache misses during dogfood (constant commits) still explode. Slice 0 first.                                          |
| Global `npm i -g` / committing a VSIX                                       | Release policy already gitignores VSIX (`docs/release.md`).                                                           |
| H5 sidebar search (RAD-65), extension UI tests (P2 remainder), extra polish | Unrelated to this outage.                                                                                             |
| Changing listen idle 30m / max 8h defaults                                  | Not implicated; the bug is per-TICK spawn, not the ceiling.                                                           |
| `parseGhAuthStatus` / `spawn("gh")` Windows PATH                            | Revisit only if Slice 0+1 still leave an empty **dropdown** while `gh auth status` works in the same Cursor terminal. |
| Refactors of `laneView.ts` HTML/CSS, MCP tool sprawl, learnings             | Out of scope.                                                                                                         |

---

## 5. Repro notes (Windows dogfood, from code)

Environment: Windows, Cursor, repo at `…\GitHub\pr-genie`, Node 20+, `pnpm build` already done. Use Task Manager or Cursor **Background Agents** / terminal pane.

### A. Watch fan-out (R1)

1. `node packages\cli\dist\prgenie.cjs watch start queue`
2. In a reviewer chat: `/watch-ready` (skill starts listen with `--interval 60` and Notify on `AGENT_LOOP_TICK_review-queue`).
3. Do **not** create new ready loops. Wait ~10–15 minutes.
4. **Expect today:** a TICK line every 60s; parent chat wakes; extra `cmd.exe` / agent tasks accumulate if the model runs `/queue` or re-arms listen.
5. **Expect after Slice 1:** one listen PID; no new reviewer Tasks.

### B. Sidebar CI / empty UI (R3)

1. Ensure at least one live (non-archived) local PR so a row is selected.
2. Clear CI cache: delete `.git\agent-console\ci-cache\` if present.
3. Reload Cursor, open **Local PRs**.
4. **Expect today:** list stays empty or frozen for a long time; CPU from `pnpm` / `node` / `prettier`; Extension host unresponsive in the debug console. `node packages\cli\dist\prgenie.cjs list` still prints loops. Doctor still passes.
5. **Expect after Slice 0:** list paints quickly; no `pnpm test` from the extension host.

### C. Review complete (R4)

1. Mark a loop `ready` (`prgenie ready <id>`).
2. Run a reviewer **Task** (not the parent chat) with `/review` on a machine where `prgenie` is not on PATH and MCP is not in the Task.
3. **Expect today:** Task text "reviewed" / "Review complete"; `prgenie show <id>` still `ready`.
4. Manual recovery (what Brett did): `node packages\cli\dist\prgenie.cjs complete-review <id>`.

### D. Shepherd "hang" (S4)

1. `node packages\cli\dist\prgenie.cjs shepherd <id>` on this repo with a cold CI cache.
2. **Expect today:** no per-check progress; process alive running `pnpm format:check` (many files), then lint, typecheck, test, build; up to 5 minutes **each**.
3. Under A+B load this looks stuck.

### E. Windows tests (R6)

```powershell
pnpm test
```

**Expect today (from code, not re-run here):**

| Failure           | File                                              | Mechanism                                                          |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `chmod` ENOENT    | `packages/core/src/attach.test.ts`                | `execFileSync("chmod", ["+x", mockGhPath])`; stub is `#!/bin/bash` |
| `ln -s`           | `packages/core/src/ci-runner.test.ts` RAD-46 CRLF | shell `ln -s` instead of `linkNodeModules`                         |
| Timeout assertion | same file, `sleep 2` / `sleep 3`                  | `child_process.exec` → `cmd.exe`; `sleep` is not a Windows command |
| EBUSY cleanup     | several `after()` `rm(..., { recursive: true })`  | Windows lock on temp git dirs / worktrees                          |

`.github/workflows/ci.yml` is `runs-on: ubuntu-latest` only — these never fail on GitHub.

### F. Install (R5)

```powershell
pnpm build
pnpm link-plugin
pnpm link-extension   # copy to %USERPROFILE%\.cursor\extensions\prgenie.prgenie-<ver>
```

Then, if Local PRs does not activate:

```powershell
pnpm pack:extension
cursor --install-extension packages\extension\prgenie-0.1.1.vsix
# quit Cursor fully (not Reload Window), reopen
```

Plugin uninstall removing `%USERPROFILE%\.cursor\plugins\local\prgenie` is expected. Relink while Cursor is running often fails or looks stale because MCP `server.cjs` is locked.

---

## 6. Code citations (for implement agents)

**Listen always ticks (even with no activity):**

```241:275:packages/core/src/watch.ts
  while (true) {
    const before = await getRepoWatch(cwd);
    // ...
    await sleep(intervalMs);
    // fingerprint only resets idle — TICK still prints every interval
    tick += 1;
    write(`${sentinel.tick} ${JSON.stringify({ prompt: sentinel.prompt })}`);
  }
```

**Sidebar poller + blocking shepherd/CI:**

```124:127:packages/extension/src/laneView.ts
  constructor(private readonly context: vscode.ExtensionContext) {
    this.showArchived = this.context.workspaceState.get("prgenie.showArchived", false);
    this.poller = setInterval(() => void this.pushSnapshot(), 2000);
  }
```

```658:685:packages/extension/src/laneView.ts
      let shepherd: ShepherdResult | null = null;
      if (selected) {
        try {
          shepherd = await shepherdStatus(root, selected.id);
        } catch (err) {
          console.error("[prgenie] Failed to fetch shepherd status:", err);
        }
      }
      this.post({ type: "snapshot", /* prs, ghBind, shepherdStatus, ... */ }, force);
```

**Shepherd = full CI:**

```92:105:packages/core/src/shepherd.ts
    if (!options.skipCiCheck) {
      const ciResult = await runCiChecks(cwd);
      if (!ciResult.allPassed) {
        for (const check of ciResult.checks) {
          if (!check.passed) {
            reasons.push({
              check: "ci",
              message: `CI check failed: ${check.name}${check.error ? ` — ${check.error}` : ""}`,
            });
          }
        }
      }
    }
```

**Per-file prettier (Windows = one cmd.exe per file):**

```110:118:packages/core/src/ci-runner.ts
async function checkFormatFromBlobs(cwd: string, files: string[]): Promise<void> {
  for (const file of files) {
    const command = `git show ":${file.replace(/"/g, '\\"')}" | pnpm exec prettier --stdin-filepath "${file.replace(/"/g, '\\"')}" --check`;
    await execAsync(command, { cwd });
  }
}
```

**Complete-review drift throw (status unchanged):**

```780:798:packages/core/src/prs.ts
export async function completeLocalPrReview(...) {
    const headDrift = Boolean(reviewedAgainstSha && reviewedAgainstSha !== pr.headSha);
    if (headDrift && !options.allowDrift) {
      throw new Error(
        `HEAD moved since Review requested ...`,
      );
    }
```

**Docs vs dogfood (VSIX optional):**

```26:26:docs/release.md
You do **not** need a VSIX for local Cursor installs — `link-extension` is enough.
```

---

## 7. Recommended PM call

Greenlight **Slice 0 + Slice 1** as the stability MVP (empty sidebar + machine lag). Slice 2 is the next flywheel fix (reviewer Task). Slices 3–6 are hardening so the next Windows dogfood is not another archaeology session.

This document is the handoff. Do not start a large `laneView` rewrite in the same PR as watch-listen caps.
