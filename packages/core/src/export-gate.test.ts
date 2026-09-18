import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { completeLocalPrReview, createLocalPr, getLocalPr, setLocalPrStatus } from "./prs.js";
import { evaluateAndStoreExportGate, validateExport } from "./export-validation.js";
import {
  displayShepherdStatus,
  formatExportBlockLabel,
  humanExportState,
  humanExportUi,
  isHumanExportable,
  needsExportGateEvaluation,
  pendingExportGate,
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
    assert.equal(humanExportUi(pr).yourTurn, true);
    assert.equal(humanExportUi(pr).showExportPrimary, true);
    assert.equal(humanExportUi(pr).listStatus, "your turn — open on GitHub");
    assert.equal(needsExportGateEvaluation(pr), false);
  });

  it("shows blocked with the failing CI check name, not Your Turn", () => {
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
  it("complete_review leaves the loop pending, not Your Turn", async () => {
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
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            test: "exit 1",
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
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
