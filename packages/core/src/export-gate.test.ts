import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { completeLocalPrReview, createLocalPr, getLocalPr, setLocalPrStatus } from "./prs.js";
import {
  abortExportGate,
  evaluateAndStoreExportGate,
  exportGateInFlight,
  validateExport,
} from "./export-validation.js";
import { isAbortError, type ProgressEvent } from "./progress.js";
import {
  displayShepherdStatus,
  exportReadyEnterKey,
  formatExportBlockLabel,
  HUMAN_EXPORT_HINT,
  HUMAN_EXPORT_PRIMARY_ACTION,
  HUMAN_EXPORT_STATUS_LABEL,
  humanExportConfirmMessage,
  humanExportEnterMessage,
  humanExportState,
  humanExportUi,
  isHumanExportable,
  needsExportGateEvaluation,
  nextExportReadyEnter,
  pendingExportGate,
  retainExportReadyNotified,
} from "./export-gate.js";
import type { LocalPr } from "./types.js";

function reviewedPr(overrides: Partial<LocalPr> = {}): LocalPr {
  return {
    id: "lp-test",
    title: "Test",
    body: "",
    status: "reviewed",
    headRef: "feat",
    baseRef: "main",
    headSha: "abc123",
    baseSha: "def456",
    worktreePath: null,
    comments: [],
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reviewRequestedSha: null,
    reviewerNotifiedSha: null,
    exportGate: null,
    ...overrides,
  };
}

async function initRepo(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "prgenie-export-gate-"));
  await git(tmp, ["init", "-b", "main"]);
  await git(tmp, ["config", "user.email", "test@example.com"]);
  await git(tmp, ["config", "user.name", "Test User"]);
  await writeFile(join(tmp, "README.md"), "# Test\n");
  await git(tmp, ["add", "."]);
  await git(tmp, ["commit", "-m", "Initial commit"]);
  return tmp;
}

describe("humanExportState", () => {
  it("is not exportable for reviewed without a stored gate", () => {
    const pr = reviewedPr();
    assert.equal(isHumanExportable(pr), false);
    assert.equal(humanExportState(pr).kind, "pending");
    assert.equal(humanExportUi(pr).yourTurn, false);
    assert.equal(humanExportUi(pr).showExportPrimary, false);
    assert.equal(humanExportUi(pr).listStatus, "reviewed");
    assert.equal(needsExportGateEvaluation(pr), true);
  });

  it("is not exportable while the stored gate is pending", () => {
    const pr = reviewedPr({ exportGate: pendingExportGate("abc123") });
    assert.equal(isHumanExportable(pr), false);
    assert.equal(humanExportState(pr).kind, "pending");
    assert.equal(needsExportGateEvaluation(pr), true);
  });

  it("treats a gate for a different HEAD as stale (not exportable)", () => {
    const pr = reviewedPr({
      exportGate: {
        status: "ready",
        reasons: [],
        headSha: "oldsha",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.equal(isHumanExportable(pr), false);
    assert.equal(humanExportState(pr).kind, "pending");
    assert.equal(needsExportGateEvaluation(pr), true);
  });

  it("is exportable only when reviewed and stored gate is ready for this HEAD", () => {
    const pr = reviewedPr({
      exportGate: {
        status: "ready",
        reasons: [],
        headSha: "abc123",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.equal(isHumanExportable(pr), true);
    const ui = humanExportUi(pr);
    assert.equal(ui.yourTurn, true);
    assert.equal(ui.showExportPrimary, true);
    assert.equal(ui.listStatus, HUMAN_EXPORT_STATUS_LABEL);
    assert.equal(ui.pillText, HUMAN_EXPORT_STATUS_LABEL);
    assert.equal(ui.hint, HUMAN_EXPORT_HINT);
    assert.equal(needsExportGateEvaluation(pr), false);
  });

  it("shows blocked with the failing CI check name, not Push to origin", () => {
    const pr = reviewedPr({
      exportGate: {
        status: "blocked",
        reasons: [{ check: "ci", message: "CI check failed: test — Command failed: pnpm test" }],
        headSha: "abc123",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const ui = humanExportUi(pr);
    assert.equal(isHumanExportable(pr), false);
    assert.equal(ui.kind, "blocked");
    assert.equal(ui.yourTurn, false);
    assert.equal(ui.showExportPrimary, false);
    assert.equal(ui.blockedLabel, "test");
    assert.equal(ui.listStatus, "blocked — test");
    assert.equal(ui.pillText, "blocked");
    assert.match(ui.hint, /test/);
    assert.equal(needsExportGateEvaluation(pr), false);
  });

  it("does not treat draft/ready as human-exportable", () => {
    assert.equal(isHumanExportable(reviewedPr({ status: "draft" })), false);
    assert.equal(isHumanExportable(reviewedPr({ status: "ready" })), false);
    assert.equal(needsExportGateEvaluation(reviewedPr({ status: "ready" })), false);
  });
});

describe("formatExportBlockLabel", () => {
  it("names format/lint/typecheck/test/build from CI reasons", () => {
    assert.equal(
      formatExportBlockLabel([
        { check: "ci", message: "CI check failed: lint — Command failed: pnpm lint" },
        { check: "ci", message: "CI check failed: typecheck — boom" },
      ]),
      "lint, typecheck",
    );
  });

  it("falls back to the first non-CI gate name", () => {
    assert.equal(
      formatExportBlockLabel([{ check: "github", message: "Repo not bound" }]),
      "github",
    );
  });
});

describe("displayShepherdStatus", () => {
  it("does not paint ready for a reviewed loop until the full gate is stored", () => {
    const painted = displayShepherdStatus({ status: "ready", reasons: [] }, reviewedPr());
    assert.equal(painted?.status, "blocked");
    assert.ok(
      painted?.reasons.some((r) => r.check === "ci" && r.message.includes("not evaluated")),
    );
  });

  it("uses the stored full gate when present", () => {
    const painted = displayShepherdStatus(
      { status: "ready", reasons: [] },
      reviewedPr({
        exportGate: {
          status: "blocked",
          reasons: [{ check: "ci", message: "CI check failed: test — failed" }],
          headSha: "abc123",
          evaluatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    assert.equal(painted?.status, "blocked");
    assert.ok(painted?.reasons.some((r) => r.message.includes("test")));
  });
});

describe("evaluateAndStoreExportGate", () => {
  it("complete_review leaves the loop pending, not Push to origin", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);
      const pr = await createLocalPr(repo, { title: "Clean", body: "Body", base: "main" });
      await setLocalPrStatus(repo, pr.id, "ready");
      const done = await completeLocalPrReview(repo, pr.id, { body: "LGTM" });
      assert.equal(done.status, "reviewed");
      assert.equal(done.exportGate?.status, "pending");
      assert.equal(isHumanExportable(done), false);
      assert.equal(needsExportGateEvaluation(done), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("persists a blocked gate naming the failing CI check; export shares it", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);
      // Untracked on purpose: format:check only sees git-tracked files (README.md).
      await writeFile(
        join(repo, "fail-test.mjs"),
        "process.stderr.write('not ok 1 - widget renders\\n'); process.exit(1);\n",
      );
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            test: "node fail-test.mjs",
            build: "exit 0",
          },
        }),
      );
      const pr = await createLocalPr(repo, { title: "CI fail", body: "Body", base: "main" });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const shepherd = await evaluateAndStoreExportGate(repo, pr.id);
      assert.equal(shepherd.status, "blocked");
      assert.ok(shepherd.reasons.some((r) => r.check === "ci" && r.message.includes("test")));

      const stored = await getLocalPr(repo, pr.id);
      assert.equal(stored.exportGate?.status, "blocked");
      assert.equal(isHumanExportable(stored), false);
      assert.equal(humanExportUi(stored).blockedLabel, "test");

      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
      assert.ok(
        validation.issues.some((issue) => issue.includes("CI") && issue.includes("test")),
        `expected CI test failure in ${validation.issues.join(" | ")}`,
      );
      assert.ok(
        validation.issues.some((issue) => issue.includes("widget renders")),
        `expected toast-facing excerpt in ${validation.issues.join(" | ")}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("single-flights concurrent evaluations and fans out progress", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: 'node -e "setTimeout(() => {}, 250)"',
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );
      const pr = await createLocalPr(repo, { title: "Flight", body: "Body", base: "main" });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const a: ProgressEvent[] = [];
      const b: ProgressEvent[] = [];
      const [first, second] = await Promise.all([
        evaluateAndStoreExportGate(repo, pr.id, { onProgress: (e) => a.push(e) }),
        evaluateAndStoreExportGate(repo, pr.id, { onProgress: (e) => b.push(e) }),
      ]);
      assert.equal(first.status, second.status);
      const lintStartsA = a.filter(
        (e) => e.phase === "ci" && e.check === "lint" && e.state === "start",
      );
      const lintStartsB = b.filter(
        (e) => e.phase === "ci" && e.check === "lint" && e.state === "start",
      );
      assert.equal(lintStartsA.length, 1);
      assert.equal(lintStartsB.length, 1);
      assert.equal(exportGateInFlight(repo, pr.id, pr.headSha), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("abortExportGate file token cancels another caller without a shared AbortSignal", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      // Commit slow lint scripts + a non-docs file so smart CI selects lint (not format-only).
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: 'node -e "setTimeout(() => {}, 30000)"',
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );
      await writeFile(join(repo, "code.ts"), "export const n = 1;\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add slow lint"]);
      const pr = await createLocalPr(repo, { title: "File abort", body: "Body", base: "main" });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const started = Date.now();
      setTimeout(() => abortExportGate(repo, pr.id, pr.headSha), 500);
      await assert.rejects(
        () => evaluateAndStoreExportGate(repo, pr.id),
        (err: unknown) => isAbortError(err),
      );
      assert.ok(Date.now() - started < 8000, "file abort should not wait out the check");
      const stored = await getLocalPr(repo, pr.id);
      assert.notEqual(stored.exportGate?.status, "ready");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("abort does not persist a ready/blocked snapshot", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: 'node -e "setTimeout(() => {}, 30000)"',
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );
      await writeFile(join(repo, "code.ts"), "export const n = 1;\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add slow lint"]);
      const pr = await createLocalPr(repo, { title: "Abort", body: "Body", base: "main" });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 80);
      await assert.rejects(
        () => evaluateAndStoreExportGate(repo, pr.id, { signal: ac.signal }),
        (err: unknown) => isAbortError(err),
      );
      const stored = await getLocalPr(repo, pr.id);
      assert.notEqual(stored.exportGate?.status, "ready");
      assert.ok(
        !stored.exportGate ||
          stored.exportGate.status === "pending" ||
          stored.exportGate.evaluatedAt === null,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("first-enter export notice", () => {
  it("keys a loop by id + HEAD so a later exportable HEAD can notify again", () => {
    assert.equal(exportReadyEnterKey({ id: "lp-a", headSha: "abc" }), "lp-a@abc");
    assert.equal(
      humanExportEnterMessage("Fix the gate"),
      '"Fix the gate" is ready — push to origin',
    );
    assert.match(humanExportConfirmMessage("Fix the gate"), /Push "Fix the gate" to origin/);
    assert.equal(HUMAN_EXPORT_PRIMARY_ACTION, "Open on GitHub");
  });

  it("offers the first exportable loop that has not been notified", () => {
    const pending = {
      id: "lp-pending",
      title: "Still gating",
      headSha: "aaa",
      humanExport: { kind: "pending" as const },
    };
    const blocked = {
      id: "lp-blocked",
      title: "CI red",
      headSha: "bbb",
      humanExport: { kind: "blocked" as const },
    };
    const ready = {
      id: "lp-ready",
      title: "Ship me",
      headSha: "ccc",
      humanExport: { kind: "exportable" as const },
    };
    assert.equal(nextExportReadyEnter([pending, blocked], []), null);
    assert.deepEqual(nextExportReadyEnter([pending, blocked, ready], []), {
      id: "lp-ready",
      title: "Ship me",
      key: "lp-ready@ccc",
    });
    assert.equal(nextExportReadyEnter([ready], ["lp-ready@ccc"]), null);
  });

  it("drops notified keys once the loop leaves exportable (re-enter can notify)", () => {
    const ready = {
      id: "lp-ready",
      title: "Ship me",
      headSha: "ccc",
      humanExport: { kind: "exportable" as const },
    };
    const pending = { ...ready, humanExport: { kind: "pending" as const } };
    assert.deepEqual(retainExportReadyNotified([ready], ["lp-ready@ccc", "stale@old"]), [
      "lp-ready@ccc",
    ]);
    assert.deepEqual(retainExportReadyNotified([pending], ["lp-ready@ccc"]), []);
  });
});
