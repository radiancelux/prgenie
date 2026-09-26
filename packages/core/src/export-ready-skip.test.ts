import assert from "node:assert/strict";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { git } from "./git.js";
import {
  createLocalPr,
  getLocalPr,
  exportPartialFailureFromRelease,
  formatReadyCarriedSkipReason,
  githubPrEditArgs,
  planReadySkipCarry,
  recordExportGateOverride,
  recordLocalPrReadyCi,
  readyCiFromSkipReason,
  setLocalPrExportGate,
  setLocalPrStatus,
  validateExport,
} from "./index.js";
import { shepherdStatus } from "./shepherd.js";
import { createTempGitRepo } from "./test-git-fixture.js";
import type { CiCheckSelection } from "./ci-select.js";

function fixtureRootSelection(checks: string[]): CiCheckSelection {
  return {
    checks,
    reason: ["export-ready-skip test fixture"],
    mapping: checks.map((check) => ({ check, reason: "fixture" })),
    uncertain: false,
    changedPaths: ["test.txt"],
    packageScoped: false,
    skipped: false,
  };
}

describe("planReadySkipCarry (RAD-144)", () => {
  it("carries per-check skip at the same HEAD and scope", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: {
        headSha: "abc",
        recordedAt: "2026-01-01T00:00:00.000Z",
        outcome: "passed",
        skipScope: ["format:check", "test:core"],
        checkSkips: [{ name: "test:core", reason: "toolchain timeout risk" }],
      },
      plannedChecks: ["format:check", "test:core"],
    });
    assert.deepEqual(plan.checksToRun, ["format:check"]);
    assert.equal(plan.carriedResults.length, 1);
    assert.equal(plan.carriedResults[0]?.name, "test:core");
    assert.equal(
      plan.carriedResults[0]?.reason,
      formatReadyCarriedSkipReason("toolchain timeout risk"),
    );
  });

  it("invalidates carry when HEAD changes", () => {
    const plan = planReadySkipCarry({
      headSha: "newtip",
      readyCi: readyCiFromSkipReason("oldtip", "no node", undefined, ["test:core"]),
      plannedChecks: ["test:core"],
    });
    assert.deepEqual(plan.checksToRun, ["test:core"]);
    assert.equal(plan.carriedResults.length, 0);
  });

  it("fail-closes when skipScope is empty and gate plan is non-empty", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: readyCiFromSkipReason("abc", "flaky test:core"),
      plannedChecks: ["format:check", "lint", "test:core"],
    });
    assert.equal(plan.scopeInvalidated, true);
    assert.deepEqual(plan.checksToRun, ["format:check", "lint", "test:core"]);
    assert.equal(plan.carriedResults.length, 0);
  });

  it("invalidates carry when skip scope changes (fail closed)", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: {
        headSha: "abc",
        recordedAt: "2026-01-01T00:00:00.000Z",
        outcome: "passed",
        skipScope: ["format:check", "test:core"],
        checkSkips: [{ name: "test:core", reason: "slow glob" }],
      },
      plannedChecks: ["format:check", "lint:core"],
    });
    assert.equal(plan.scopeInvalidated, true);
    assert.deepEqual(plan.checksToRun, ["format:check", "lint:core"]);
    assert.equal(plan.carriedResults.length, 0);
  });

  it("carries whole-plan skip with matching scope", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: readyCiFromSkipReason("abc", "toolchain missing", undefined, [
        "format:check",
        "test:core",
      ]),
      plannedChecks: ["format:check", "test:core"],
    });
    assert.deepEqual(plan.checksToRun, []);
    assert.equal(plan.carriedResults.length, 2);
    assert.match(plan.carriedResults[0]?.reason ?? "", /skipped \(ready: toolchain missing\)/);
  });
});

describe("export gate honour ready skips", () => {
  it("does not re-run a check skipped at ready for the same HEAD", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-ready-skip-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, { title: "Skip carry", body: "Body", base: "main" });
      assert.ok(pr.worktreePath);
      const headSha = pr.headSha;
      await recordLocalPrReadyCi(repo, pr.id, {
        headSha,
        recordedAt: new Date().toISOString(),
        outcome: "passed",
        skipScope: ["lint", "test:core"],
        checkSkips: [{ name: "test:core", reason: "recorded at ready" }],
        checks: ["lint"],
      });
      await writeFile(
        path.join(pr.worktreePath, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
            test: "exit 1",
          },
        }),
      );
      await writeFile(path.join(pr.worktreePath, ".gitignore"), "node_modules\n");
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(pr.worktreePath, "node_modules"),
        type,
      );
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const shepherd = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        selection: fixtureRootSelection(["lint", "test:core"]),
      });
      assert.equal(shepherd.status, "ready");
      const carried = shepherd.ciChecks?.find((c) => c.name === "test:core");
      assert.ok(carried?.skipped);
      assert.match(carried?.reason ?? "", /skipped \(ready: recorded at ready\)/);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("export refusal and override (RAD-144)", () => {
  it("refuses export while the gate is blocked", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-export-block-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, { title: "Blocked", body: "Body", base: "main" });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      await setLocalPrExportGate(repo, pr.id, {
        status: "blocked",
        reasons: [{ check: "ci", message: "CI check failed: test:core — timeout" }],
        headSha: pr.headSha,
        evaluatedAt: new Date().toISOString(),
        ciChecks: [{ name: "test:core", passed: false }],
      });
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
      assert.ok(validation.issues.some((i) => /Export gate is blocked/.test(i)));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("allows export with documented exportGateOverride", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-export-override-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, {
        title: "Override",
        body: "Override by QA Lead because test:core timed out on green.",
        base: "main",
      });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      await setLocalPrExportGate(repo, pr.id, {
        status: "blocked",
        reasons: [{ check: "ci", message: "CI check failed: test:core — timeout" }],
        headSha: pr.headSha,
        evaluatedAt: new Date().toISOString(),
      });
      await recordExportGateOverride(repo, pr.id, {
        who: "QA Lead",
        why: "test:core timed out on green",
      });
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, true);
      const fresh = await getLocalPr(repo, pr.id);
      assert.equal(fresh.exportGateOverride?.headSha, pr.headSha);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not allow override after HEAD moves", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-export-override-move-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, {
        title: "Override move",
        body: "Override by QA Lead because test:core timed out on green.",
        base: "main",
      });
      await setLocalPrStatus(repo, pr.id, "reviewed");
      await setLocalPrExportGate(repo, pr.id, {
        status: "blocked",
        reasons: [{ check: "ci", message: "CI check failed: test:core — timeout" }],
        headSha: pr.headSha,
        evaluatedAt: new Date().toISOString(),
      });
      await recordExportGateOverride(repo, pr.id, {
        who: "QA Lead",
        why: "test:core timed out on green",
      });
      await writeFile(path.join(repo, "test.txt"), "y\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "follow-up"]);
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not allow override to bypass review blocks", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-export-override-review-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, {
        title: "Override review",
        body: "Override by QA Lead because test:core timed out on green.",
        base: "main",
      });
      await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
      await recordExportGateOverride(repo, pr.id, {
        who: "QA Lead",
        why: "test:core timed out on green",
      });
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
      assert.ok(validation.issues.some((i) => /Review:/.test(i)));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("githubPrEditArgs (RAD-150)", () => {
  it("uses --body-file for multiline-safe edit", () => {
    const args = githubPrEditArgs({
      headRef: "lp-abc",
      title: "New title",
      bodyFile: "C:\\tmp\\body.md",
    });
    assert.deepEqual(args, [
      "pr",
      "edit",
      "lp-abc",
      "--title",
      "New title",
      "--body-file",
      "C:\\tmp\\body.md",
    ]);
  });
});

describe("exportPartialFailureFromRelease body update (RAD-150)", () => {
  it("reports body-update failure as partial failure", () => {
    const partial = exportPartialFailureFromRelease(
      "https://github.com/o/r/pull/1",
      {
        checkedOutBase: true,
        prunedWorktree: true,
        deletedBranch: true,
        primaryPath: "/repo",
        reopen: false,
        worktreeLeftoverPath: null,
        pruneError: null,
        branch: "lp-x",
        branchError: null,
      },
      null,
      { ok: false, error: "gh pr edit: permission denied" },
    );
    assert.ok(partial);
    assert.match(partial.message, /body update failed/i);
    assert.equal(partial.bodyUpdated, false);
    assert.match(partial.bodyUpdateError ?? "", /permission denied/);
  });
});
