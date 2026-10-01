import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
  evaluateAndStoreExportGate,
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

  it("keeps a same-HEAD plan and carries only the named checks", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: readyCiFromSkipReason(
        "abc",
        "flaky on Windows",
        undefined,
        ["format:check", "lint", "typecheck", "test:core"],
        ["test:core"],
      ),
      plannedChecks: ["format:check", "lint", "typecheck", "test:core"],
    });
    assert.equal(plan.scopeInvalidated, false);
    assert.deepEqual(plan.checksToRun, ["format:check", "lint", "typecheck"]);
    assert.equal(plan.carriedResults.length, 1);
    assert.equal(plan.carriedResults[0]?.name, "test:core");
    assert.match(plan.carriedResults[0]?.reason ?? "", /skipped \(ready: flaky on Windows\)/);
  });

  it("carries a named-only skip when the gate plan is a superset", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: readyCiFromSkipReason("abc", "flaky on Windows", undefined, [], ["test:core"]),
      plannedChecks: ["format:check", "lint", "typecheck", "test:core"],
    });
    assert.equal(plan.scopeInvalidated, false);
    assert.deepEqual(plan.checksToRun, ["format:check", "lint", "typecheck"]);
    assert.equal(plan.carriedResults.length, 1);
    assert.equal(plan.carriedResults[0]?.name, "test:core");
    assert.match(plan.carriedResults[0]?.reason ?? "", /skipped \(ready: flaky on Windows\)/);
  });

  it("fail-closes when the gate plan drops a named check", () => {
    const plan = planReadySkipCarry({
      headSha: "abc",
      readyCi: readyCiFromSkipReason("abc", "flaky", undefined, [], ["lint", "test:core"]),
      plannedChecks: ["format:check", "test:core"],
    });
    assert.equal(plan.scopeInvalidated, true);
    assert.deepEqual(plan.checksToRun, ["format:check", "test:core"]);
    assert.equal(plan.carriedResults.length, 0);
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
      assert.ok(!shepherd.reasons.some((r) => /ci-plan/.test(r.message)));
      const carried = shepherd.ciChecks?.find((c) => c.name === "test:core");
      assert.ok(carried?.skipped);
      assert.match(carried?.reason ?? "", /skipped \(ready: recorded at ready\)/);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-154: empty plan with changed files is not exportable", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-rad154-empty-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await mkdir(path.join(repo, "assets"), { recursive: true });
      await writeFile(path.join(repo, "assets", "logo.bin"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "logo"]);
      const pr = await createLocalPr(repo, { title: "Empty plan", body: "Body", base: "main" });
      assert.ok(pr.worktreePath);
      await writeFile(path.join(pr.worktreePath, ".gitignore"), "node_modules\n");
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(pr.worktreePath, "node_modules"),
        type,
      );
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const shepherd = await evaluateAndStoreExportGate(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
      });
      assert.equal(shepherd.status, "blocked");
      const stored = await getLocalPr(repo, pr.id);
      assert.equal(stored.exportGate?.status, "blocked");
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-154: documented override naming ci-plan allows export", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-rad154-override-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await mkdir(path.join(repo, "assets"), { recursive: true });
      await writeFile(path.join(repo, "assets", "logo.bin"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "logo"]);
      const pr = await createLocalPr(repo, {
        title: "Override",
        body: "Override by brett because the diff is binary-only assets.\nSkipped checks: `ci-plan`",
        base: "main",
      });
      assert.ok(pr.worktreePath);
      await writeFile(path.join(pr.worktreePath, ".gitignore"), "node_modules\n");
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(pr.worktreePath, "node_modules"),
        type,
      );
      await setLocalPrStatus(repo, pr.id, "reviewed");
      await evaluateAndStoreExportGate(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
      });
      await recordExportGateOverride(repo, pr.id, {
        who: "brett",
        why: "the diff is binary-only assets",
      });
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("carries a named human skip when the gate plan is a superset and no prior readyCi", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-human-skip-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, { title: "Human skip", body: "Body", base: "main" });
      assert.ok(pr.worktreePath);
      assert.equal(pr.readyCi ?? null, null);
      const ready = await setLocalPrStatus(repo, pr.id, "ready", {
        skipPreflight: true,
        ciSkipReason: "flaky on Windows",
        ciSkipChecks: ["test:core"],
      });
      assert.equal(ready.readyCi?.headSha, pr.headSha);
      assert.deepEqual(ready.readyCi?.skipScope, ["test:core"]);
      assert.deepEqual(ready.readyCi?.checkSkips, [
        { name: "test:core", reason: "flaky on Windows" },
      ]);
      await writeFile(
        path.join(pr.worktreePath, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
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
      const gatePlan = ["format:check", "lint", "typecheck", "test:core"];
      const shepherd = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        selection: fixtureRootSelection(gatePlan),
      });
      assert.equal(shepherd.status, "ready");
      const carried = shepherd.ciChecks?.find((c) => c.name === "test:core");
      assert.ok(carried?.skipped);
      assert.match(carried?.reason ?? "", /skipped \(ready: flaky on Windows\)/);
      for (const name of ["format:check", "lint", "typecheck"]) {
        const ran = shepherd.ciChecks?.find((c) => c.name === name);
        assert.equal(ran?.passed, true, name);
        assert.equal(ran?.skipped ?? false, false, name);
      }
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("ignores prior readyCi scope when its HEAD differs", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-human-skip-head-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, { title: "Stale scope", body: "Body", base: "main" });
      await recordLocalPrReadyCi(repo, pr.id, {
        headSha: "0".repeat(40),
        recordedAt: new Date().toISOString(),
        outcome: "skipped",
        skipReason: "old run",
        skipScope: ["lint"],
        checks: [],
      });
      const ready = await setLocalPrStatus(repo, pr.id, "ready", {
        skipPreflight: true,
        ciSkipReason: "flaky",
        ciSkipChecks: ["test:core"],
      });
      assert.equal(ready.readyCi?.headSha, pr.headSha);
      assert.deepEqual(ready.readyCi?.skipScope, ["test:core"]);
      assert.deepEqual(ready.readyCi?.checkSkips, [{ name: "test:core", reason: "flaky" }]);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a same-HEAD plan when a human names a subset", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-human-skip-plan-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, { title: "Keep plan", body: "Body", base: "main" });
      const gatePlan = ["format:check", "lint", "typecheck", "test:core"];
      await recordLocalPrReadyCi(repo, pr.id, {
        headSha: pr.headSha,
        recordedAt: new Date().toISOString(),
        outcome: "passed",
        skipScope: gatePlan,
        checks: gatePlan,
      });
      const ready = await setLocalPrStatus(repo, pr.id, "ready", {
        skipPreflight: true,
        ciSkipReason: "flaky on Windows",
        ciSkipChecks: ["test:core"],
      });
      assert.equal(ready.readyCi?.headSha, pr.headSha);
      assert.deepEqual(ready.readyCi?.skipScope, [
        "format:check",
        "lint",
        "test:core",
        "typecheck",
      ]);
      assert.deepEqual(ready.readyCi?.checkSkips, [
        { name: "test:core", reason: "flaky on Windows" },
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("partial readyCi triggers missing checks on export (162-R3)", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-partial-ready-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, { title: "Partial ready", body: "Body", base: "main" });
      assert.ok(pr.worktreePath);
      const headSha = pr.headSha;
      await recordLocalPrReadyCi(repo, pr.id, {
        headSha,
        recordedAt: new Date().toISOString(),
        outcome: "passed",
        skipScope: ["lint", "test:core"],
        checks: ["lint"],
        checkResults: [{ name: "lint", outcome: "passed" }],
      });
      await writeFile(
        path.join(pr.worktreePath, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
            "test:core": "exit 0",
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
      const lint = shepherd.ciChecks?.find((c) => c.name === "lint");
      assert.match(lint?.reason ?? "", /passed at ready \(RAD-162\)/);
      const testCore = shepherd.ciChecks?.find((c) => c.name === "test:core");
      assert.ok(testCore?.passed && !testCore.skipped);
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
        body: "Override by QA Lead because test:core timed out on green.\nSkipped checks: `test:core`",
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

  it("does not allow override when the body omits skipped check names", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-export-override-unnamed-" });
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      const pr = await createLocalPr(repo, {
        title: "Override unnamed",
        body: "Override by QA Lead because the suite was flaky.",
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
        why: "the suite was flaky",
      });
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
      assert.ok(validation.issues.some((i) => /Export gate is blocked/.test(i)));
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
      assert.ok(pr.worktreePath);
      const beforeSha = pr.headSha;
      await writeFile(path.join(pr.worktreePath, "test.txt"), "y\n");
      await git(pr.worktreePath, ["add", "."]);
      await git(pr.worktreePath, ["commit", "-m", "follow-up"]);
      const validation = await validateExport(repo, pr.id);
      assert.equal(validation.ok, false);
      const fresh = await getLocalPr(repo, pr.id);
      assert.equal(fresh.exportGateOverride, null);
      assert.notEqual(fresh.headSha, beforeSha);
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
      prUrl: "https://github.com/o/r/pull/12",
      title: "New title",
      bodyFile: "C:\\tmp\\body.md",
    });
    assert.deepEqual(args, [
      "pr",
      "edit",
      "https://github.com/o/r/pull/12",
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
