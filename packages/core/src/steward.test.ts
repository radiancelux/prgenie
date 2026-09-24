import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pendingExportGate } from "./export-gate.js";
import { createLocalPr, getLocalPr, setLocalPrExportGate, setLocalPrStatus } from "./prs.js";
import {
  bindSteward,
  clearStewardBinding,
  decideStewardAction,
  formatStewardDecision,
  getStewardBinding,
  listStewardBindings,
  stewardNext,
} from "./steward.js";
import type { LocalPr } from "./types.js";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function prStub(
  overrides: Partial<LocalPr> = {},
): Pick<LocalPr, "id" | "status" | "headSha" | "exportGate"> {
  return {
    id: "lp-loop1",
    status: "draft",
    headSha: "abc123",
    exportGate: null,
    ...overrides,
  };
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-steward-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feat/steward"]);
  await writeFile(path.join(repo, "a.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "work"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("decideStewardAction resumes the same implementor on changes_requested", () => {
  const first = decideStewardAction(prStub({ status: "changes_requested" }), {
    loopId: "lp-loop1",
    implementorTaskId: "task-impl-1",
    reviewerTaskId: "task-rev-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(first.kind, "resume_implementor");
  assert.equal(first.implementorTaskId, "task-impl-1");
  assert.equal(first.resumeSameImplementor, true);
  assert.equal(first.yourTurn, false);
  assert.equal(first.humanExportable, false);

  const twin = decideStewardAction(
    prStub({ status: "changes_requested" }),
    {
      loopId: "lp-loop1",
      implementorTaskId: "task-impl-1",
      reviewerTaskId: "task-rev-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    { implementorMissing: true },
  );
  assert.equal(twin.kind, "spawn_implementor");
  assert.equal(twin.resumeSameImplementor, false);
  assert.equal(twin.implementorTaskId, null);

  const failed = decideStewardAction(
    prStub({ status: "changes_requested" }),
    {
      loopId: "lp-loop1",
      implementorTaskId: "task-impl-1",
      reviewerTaskId: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    { implementorFailed: true },
  );
  assert.equal(failed.kind, "spawn_implementor");

  const restart = decideStewardAction(
    prStub({ status: "draft" }),
    {
      loopId: "lp-loop1",
      implementorTaskId: "task-impl-1",
      reviewerTaskId: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    { restart: true },
  );
  assert.equal(restart.kind, "spawn_implementor");
});

test("decideStewardAction does not hand off while export gate is blocked", () => {
  const blocked = decideStewardAction(
    prStub({
      status: "reviewed",
      exportGate: {
        status: "blocked",
        reasons: [{ check: "ci", message: "CI check failed: lint — prettier" }],
        headSha: "abc123",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    {
      loopId: "lp-loop1",
      implementorTaskId: "task-impl-1",
      reviewerTaskId: "task-rev-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(blocked.kind, "resume_implementor");
  assert.equal(blocked.resumeSameImplementor, true);
  assert.equal(blocked.implementorTaskId, "task-impl-1");
  assert.equal(blocked.failingCheck, "lint");
  assert.equal(blocked.yourTurn, false);
  assert.equal(blocked.humanExportable, false);
  assert.match(blocked.reason, /do not show Push to origin/);
});

test("decideStewardAction hands off only when the export gate is ready", () => {
  const pending = decideStewardAction(
    prStub({ status: "reviewed", exportGate: pendingExportGate("abc123") }),
    null,
  );
  assert.equal(pending.kind, "evaluate_export_gate");
  assert.equal(pending.yourTurn, false);
  assert.equal(pending.humanExportable, false);

  const ready = decideStewardAction(
    prStub({
      status: "reviewed",
      exportGate: {
        status: "ready",
        reasons: [],
        headSha: "abc123",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    {
      loopId: "lp-loop1",
      implementorTaskId: "task-impl-1",
      reviewerTaskId: "task-rev-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(ready.kind, "handoff_human");
  assert.equal(ready.humanExportable, true);
  assert.equal(ready.yourTurn, true);
});

test("bindSteward persists loopId + Task ids and stewardNext resumes them", async () => {
  const pr = await createLocalPr(repo, { title: "Steward durable map", base: "main" });
  const bound = await bindSteward(repo, pr.id, {
    implementorTaskId: "task-impl-9",
    reviewerTaskId: "task-rev-9",
  });
  assert.equal(bound.loopId, pr.id);
  assert.equal(bound.implementorTaskId, "task-impl-9");
  assert.equal(bound.reviewerTaskId, "task-rev-9");

  const loaded = await getStewardBinding(repo, pr.id);
  assert.equal(loaded?.implementorTaskId, "task-impl-9");
  assert.equal(loaded?.reviewerTaskId, "task-rev-9");

  await setLocalPrStatus(repo, pr.id, "changes_requested");
  const next = await stewardNext(repo, pr.id);
  assert.equal(next.decision.kind, "resume_implementor");
  assert.equal(next.decision.implementorTaskId, "task-impl-9");
  assert.equal(next.decision.resumeSameImplementor, true);
  assert.equal(next.binding.implementorTaskId, "task-impl-9");
  assert.match(formatStewardDecision(next), /resume_implementor/);

  const listed = await listStewardBindings(repo);
  assert.ok(listed.some((b) => b.loopId === pr.id && b.implementorTaskId === "task-impl-9"));
});

test("stewardNext gate-before-handoff: blocked CI resumes implementor, ready hands off", async () => {
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/steward-gate"]);
  await writeFile(path.join(repo, "gate.txt"), "g\n");
  git(["add", "."]);
  git(["commit", "-m", "gate"]);

  const pr = await createLocalPr(repo, { title: "Steward gate handoff", base: "main" });
  await bindSteward(repo, pr.id, { implementorTaskId: "task-impl-ci" });
  await setLocalPrStatus(repo, pr.id, "reviewed", { skipBindCheck: true });
  const stored = await setLocalPrExportGate(repo, pr.id, {
    status: "blocked",
    reasons: [{ check: "ci", message: "CI check failed: typecheck — tsc" }],
    headSha: pr.headSha,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });

  const blocked = await stewardNext(repo, stored.id, { evaluateGate: false });
  assert.equal(blocked.decision.kind, "resume_implementor");
  assert.equal(blocked.decision.resumeSameImplementor, true);
  assert.equal(blocked.decision.implementorTaskId, "task-impl-ci");
  assert.equal(blocked.decision.failingCheck, "typecheck");
  assert.equal(blocked.decision.yourTurn, false);
  assert.equal(blocked.decision.humanExportable, false);

  await setLocalPrExportGate(repo, pr.id, {
    status: "ready",
    reasons: [],
    headSha: pr.headSha,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });
  const ready = await stewardNext(repo, pr.id, { evaluateGate: false });
  assert.equal(ready.decision.kind, "handoff_human");
  assert.equal(ready.decision.humanExportable, true);
  assert.equal(ready.decision.yourTurn, true);

  await setLocalPrStatus(repo, pr.id, "approved");
  await clearStewardBinding(repo, pr.id);
  assert.equal(await getStewardBinding(repo, pr.id), null);
});

test("abortCiForSteward returns stop_implementor when a Task is bound (RAD-112)", async () => {
  const { abortCiForSteward } = await import("./export-validation.js");
  const pr = await createLocalPr(repo, { title: "CI skip steward", base: "main" });
  await bindSteward(repo, pr.id, { implementorTaskId: "task-impl-skip" });
  const withTask = await abortCiForSteward(repo, pr.id);
  assert.equal(withTask.aborted, true);
  assert.equal(withTask.implementorTaskId, "task-impl-skip");
  assert.equal(withTask.stewardAction, "stop_implementor_and_abort_ci");
  assert.match(withTask.message, /stop\/interrupt implementor Task task-impl-skip/);

  await clearStewardBinding(repo, pr.id);
  const alone = await abortCiForSteward(repo, pr.id);
  assert.equal(alone.implementorTaskId, null);
  assert.equal(alone.stewardAction, "abort_ci_only");
});

test("RAD-125: stewardNext refreshes headSha before matching a blocked gate", async () => {
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/rad-125-stale-head"]);
  await writeFile(path.join(repo, "rad125.txt"), "a\n");
  git(["add", "."]);
  git(["commit", "-m", "rad125 a"]);

  const pr = await createLocalPr(repo, { title: "RAD-125 refresh", base: "main" });
  const oldSha = pr.headSha;
  const tipCwd = pr.worktreePath ?? repo;
  await bindSteward(repo, pr.id, { implementorTaskId: "task-impl-125" });
  await setLocalPrStatus(repo, pr.id, "reviewed", { skipBindCheck: true });
  await setLocalPrExportGate(repo, pr.id, {
    status: "blocked",
    reasons: [{ check: "ci", message: "CI check failed: test — Command failed: pnpm test" }],
    headSha: oldSha,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });

  await writeFile(path.join(tipCwd, "rad125.txt"), "b\n");
  git(["add", "."], tipCwd);
  git(["commit", "-m", "rad125 b"], tipCwd);
  const newSha = git(["rev-parse", "HEAD"], tipCwd);
  assert.notEqual(newSha, oldSha);

  // Packet still has old headSha on disk until stewardNext refreshes.
  const next = await stewardNext(repo, pr.id, { evaluateGate: false });
  // RAD-126: tip moved after CLEAN → re-enter review (not resume for stale test).
  assert.equal(next.status, "ready");
  assert.equal(next.decision.kind, "spawn_reviewer");
  assert.equal(next.decision.humanExportable, false);
  assert.notEqual(next.decision.failingCheck, "test");
  assert.equal(next.exportGate, null);
  // stewardNext already refreshed; disk head matches tip.
  const shown = await getLocalPr(repo, pr.id);
  assert.equal(shown.headSha, newSha);
  assert.equal(shown.status, "ready");
});

test("RAD-126: decideStewardAction labels refused plan as ci-select not test", () => {
  const decided = decideStewardAction(
    prStub({
      status: "reviewed",
      exportGate: {
        status: "blocked",
        reasons: [
          {
            check: "ci",
            message:
              'Refusing stale full-suite CI plan (RAD-123): checks=["test"] — never root pnpm test. Use worktree selectCiChecks.',
          },
        ],
        headSha: "abc123",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    {
      loopId: "lp-loop1",
      implementorTaskId: "task-impl-1",
      reviewerTaskId: "task-rev-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(decided.kind, "resume_implementor");
  assert.equal(decided.failingCheck, "ci-select");
  assert.match(decided.reason, /worktree select|do not fix root pnpm test/i);
});
