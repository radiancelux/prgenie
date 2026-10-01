import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CI_CHECKS, selectCiChecks } from "./ci-select.js";
import {
  ciSelectionPlansEqual,
  clearWorktreeCiSelectCache,
  isCiSelectionSourcePath,
  isPrGenieRepo,
  loadBaseRefSelectCiChecks,
  loadWorktreeSelectCiChecks,
  looksLikeStaleFullSuitePlan,
  resolveCiSelection,
  touchesCiSelectionSource,
  type CiSelectFn,
} from "./ci-select-worktree.js";
import type { CiCheckSelection } from "./ci-select.js";

function repoRoot(): string {
  return process.cwd();
}

function scopedCoreSelect(changedPaths: string[]): CiCheckSelection {
  return {
    checks: ["format:check", "lint:core", "typecheck:core", "test:core"],
    reason: [
      "packages/core/** → per-package format + lint + typecheck + unit tests",
      "confident mapping — not full monorepo pnpm test",
      "worktree stub scoped",
    ],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: true,
    skipped: false,
  };
}

function scopedCoreSelectFn(): CiSelectFn {
  return (changedPaths) => scopedCoreSelect(changedPaths);
}

async function writeFakeWorktreeSelect(root: string, body: string): Promise<void> {
  const dir = path.join(root, "packages", "core", "src");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "prgenie", private: true }),
  );
  await writeFile(path.join(dir, "ci-select.ts"), body, "utf8");
}

describe("ci-select-worktree (RAD-123)", () => {
  it("detects ci-select / ci-runner source paths", () => {
    assert.equal(isCiSelectionSourcePath("packages/core/src/ci-select.ts"), true);
    assert.equal(isCiSelectionSourcePath("packages/core/src/ci-runner.ts"), true);
    assert.equal(isCiSelectionSourcePath("packages/core/src/ci-select-worktree.ts"), true);
    assert.equal(isCiSelectionSourcePath("packages/core/src/git.ts"), false);
    assert.equal(
      touchesCiSelectionSource(["docs/ci-checks.md", "packages/core/src/ci-select.ts"]),
      true,
    );
    assert.equal(touchesCiSelectionSource(["packages/core/src/git.ts"]), false);
  });

  it("ciSelectionPlansEqual treats skipped/uncertain/packageScoped drift as unequal", () => {
    const base: CiCheckSelection = {
      checks: [],
      reason: ["skip local CI"],
      mapping: [],
      uncertain: true,
      changedPaths: ["assets/logo.png"],
      packageScoped: false,
      skipped: true,
    };
    assert.equal(ciSelectionPlansEqual(base, { ...base }), true);
    assert.equal(ciSelectionPlansEqual(base, { ...base, skipped: false }), false);
    assert.equal(ciSelectionPlansEqual(base, { ...base, uncertain: false }), false);
    assert.equal(
      ciSelectionPlansEqual(
        {
          ...base,
          checks: ["format:check"],
          skipped: false,
          uncertain: false,
          packageScoped: true,
        },
        {
          ...base,
          checks: ["format:check"],
          skipped: false,
          uncertain: false,
          packageScoped: false,
        },
      ),
      false,
    );
  });

  it("uses worktree plan when installed plugin returns the stale full suite (ci-select-only loop)", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad123-"));
    try {
      await writeFakeWorktreeSelect(
        wt,
        `export function selectCiChecks(changedPaths: string[]) {
  return {
    checks: ["format:check", "lint:core", "typecheck:core", "test:core"],
    reason: [
      "packages/core/** → per-package format + lint + typecheck + unit tests",
      "confident mapping — not full monorepo pnpm test",
      "worktree stub for RAD-123",
    ],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: true,
    skipped: false,
  };
}
`,
      );

      const staleInstalled = () => ({
        checks: [...DEFAULT_CI_CHECKS],
        reason: ["cli+core source/test changed — format, lint, typecheck, test, build"],
        mapping: [],
        uncertain: false,
        changedPaths: ["packages/core/src/ci-select.ts"],
        packageScoped: false,
        skipped: false,
      });

      const result = await resolveCiSelection({
        changedPaths: ["packages/core/src/ci-select.ts"],
        worktreePath: wt,
        installedSelect: staleInstalled,
        primaryPath: repoRoot(),
        loadBaseRefSelect: async () => scopedCoreSelectFn(),
      });

      assert.equal(result.source, "base");
      assert.equal(result.diverged, true);
      assert.ok(result.warning);
      assert.ok(!result.selection.checks.includes("test"));
      assert.ok(!result.selection.checks.includes("build"));
      assert.notDeepEqual(result.selection.checks, [...DEFAULT_CI_CHECKS]);
      assert.deepEqual(result.selection.checks, [
        "format:check",
        "lint:core",
        "typecheck:core",
        "test:core",
      ]);
      assert.ok(result.selection.reason.some((r) => /RAD-167-R1/.test(r)));
    } finally {
      clearWorktreeCiSelectCache();
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("prefers worktree on diverge when diff does not touch selection sources (git.ts only)", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad123-nt-"));
    try {
      await writeFakeWorktreeSelect(
        wt,
        `export function selectCiChecks(changedPaths: string[]) {
  return {
    checks: ["format:check", "lint:core", "typecheck:core", "test:core"],
    reason: [
      "packages/core/** → per-package format + lint + typecheck + unit tests",
      "confident mapping — not full monorepo pnpm test",
      "worktree stub non-touch diverge",
    ],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: true,
    skipped: false,
  };
}
`,
      );

      const paths = ["packages/core/src/git.ts"];
      assert.equal(touchesCiSelectionSource(paths), false);

      const staleInstalled = () => ({
        checks: [...DEFAULT_CI_CHECKS],
        reason: ["cli+core source/test changed — format, lint, typecheck, test, build"],
        mapping: [],
        uncertain: false,
        changedPaths: paths,
        packageScoped: false,
        skipped: false,
      });

      const result = await resolveCiSelection({
        changedPaths: paths,
        worktreePath: wt,
        installedSelect: staleInstalled,
        primaryPath: repoRoot(),
        loadBaseRefSelect: async () => scopedCoreSelectFn(),
      });

      assert.equal(result.source, "base");
      assert.equal(result.diverged, true);
      assert.ok(!result.selection.checks.includes("test"));
      assert.ok(!result.selection.checks.includes("build"));
      assert.notDeepEqual(result.selection.checks, [...DEFAULT_CI_CHECKS]);
      assert.equal(result.selection.packageScoped, true);
      assert.deepEqual(result.selection.checks, [
        "format:check",
        "lint:core",
        "typecheck:core",
        "test:core",
      ]);
    } finally {
      clearWorktreeCiSelectCache();
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("RAD-154: hard-config full plan is not a stale full suite", () => {
    const plan = selectCiChecks(["package.json"]);
    assert.deepEqual(plan.checks, [...DEFAULT_CI_CHECKS]);
    assert.equal(looksLikeStaleFullSuitePlan(plan), false);
    const stamped = {
      ...plan,
      reason: [...plan.reason, "RAD-123: using worktree ci-select"],
    };
    assert.equal(looksLikeStaleFullSuitePlan(stamped), false);
    assert.equal(
      looksLikeStaleFullSuitePlan({
        checks: [...DEFAULT_CI_CHECKS],
        reason: ["core source/test changed — format, lint, typecheck, test, build"],
      }),
      true,
    );
  });

  it("RAD-154: missing worktree module still returns the installed full plan for package.json", async () => {
    const result = await resolveCiSelection({
      changedPaths: ["package.json"],
      worktreePath: path.join(tmpdir(), "prgenie-rad154-missing-wt"),
      installedSelect: selectCiChecks,
    });
    assert.deepEqual(result.selection.checks, [...DEFAULT_CI_CHECKS]);
    assert.equal(result.source, "installed");
  });

  it("refuses when ci-select is touched but worktree module is missing", async () => {
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-missing-wt-"));
    try {
      await writeFile(
        path.join(wt, "package.json"),
        JSON.stringify({ name: "prgenie", private: true }),
      );
      await assert.rejects(
        () =>
          resolveCiSelection({
            changedPaths: ["packages/core/src/ci-runner.ts"],
            worktreePath: wt,
            installedSelect: selectCiChecks,
            loadBaseRefSelect: async () => null,
          }),
        /Refusing stale installed CI selection/,
      );
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("always uses worktree when module loads even if plans match and paths do not touch selection", async () => {
    clearWorktreeCiSelectCache();
    const paths = ["packages/core/src/git.ts"];
    assert.equal(touchesCiSelectionSource(paths), false);
    const installed = selectCiChecks(paths);
    const result = await resolveCiSelection({
      changedPaths: paths,
      worktreePath: repoRoot(),
      installedSelect: () => installed,
      primaryPath: repoRoot(),
    });
    assert.equal(result.source, "base");
    assert.equal(result.diverged, false);
    assert.deepEqual(result.selection.checks, installed.checks);
    assert.ok(result.selection.reason.some((r) => /RAD-167-R1/.test(r)));
  });

  it("refuses when worktree load fails and installed plan looks like a stale full suite", async () => {
    await assert.rejects(
      () =>
        resolveCiSelection({
          changedPaths: ["packages/core/src/git.ts"],
          worktreePath: process.cwd(),
          installedSelect: () => ({
            checks: [...DEFAULT_CI_CHECKS],
            reason: ["core source/test changed — format, lint, typecheck, test, build"],
            mapping: [],
            uncertain: false,
            changedPaths: ["packages/core/src/git.ts"],
            packageScoped: false,
            skipped: false,
          }),
          loadBaseRefSelect: async () => null,
          loadWorktreeSelect: async () => null,
        }),
      /Refusing stale installed CI selection|full suite/,
    );
  });

  it("falls back to tsx CLI when in-process tsImport throws (dead service)", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad123-tsx-dead-"));
    try {
      await writeFakeWorktreeSelect(
        wt,
        `export function selectCiChecks(changedPaths: string[]) {
  return {
    checks: ["format:check", "lint:core", "typecheck:core", "test:core"],
    reason: [
      "packages/core/** → per-package format + lint + typecheck + unit tests",
      "confident mapping — not full monorepo pnpm test",
      "worktree stub after dead tsImport",
    ],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: true,
    skipped: false,
  };
}
`,
      );

      const loaded = await loadWorktreeSelectCiChecks(wt, {
        primaryPath: repoRoot(),
        tsImport: async () => {
          throw new Error("The service is no longer running");
        },
      });
      assert.ok(loaded, "expected CLI fallback selectCiChecks, not null/refuse");
      const fromCli = loaded!(["packages/core/src/ci-select.ts"]);
      assert.deepEqual(fromCli.checks, [
        "format:check",
        "lint:core",
        "typecheck:core",
        "test:core",
      ]);
      assert.equal(fromCli.packageScoped, true);

      // Diff touches ci-select + stale installed full suite must still resolve via CLI, not refuse.
      const result = await resolveCiSelection({
        changedPaths: ["packages/core/src/ci-select.ts"],
        worktreePath: wt,
        installedSelect: () => ({
          checks: [...DEFAULT_CI_CHECKS],
          reason: ["cli+core source/test changed — format, lint, typecheck, test, build"],
          mapping: [],
          uncertain: false,
          changedPaths: ["packages/core/src/ci-select.ts"],
          packageScoped: false,
          skipped: false,
        }),
        primaryPath: repoRoot(),
        loadBaseRefSelect: async () => scopedCoreSelectFn(),
        loadWorktreeSelect: (p) =>
          loadWorktreeSelectCiChecks(p, {
            primaryPath: repoRoot(),
            tsImport: async () => {
              throw new Error("The service is no longer running");
            },
          }),
      });
      assert.equal(result.source, "base");
      assert.ok(!result.selection.checks.includes("test"));
      assert.notDeepEqual(result.selection.checks, [...DEFAULT_CI_CHECKS]);
    } finally {
      clearWorktreeCiSelectCache();
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("prefer worktree when plans match but diff touches ci-select", async () => {
    clearWorktreeCiSelectCache();
    const paths = ["packages/core/src/ci-select.ts"];
    const installed = selectCiChecks(paths);
    const result = await resolveCiSelection({
      changedPaths: paths,
      worktreePath: repoRoot(),
      installedSelect: () => installed,
      primaryPath: repoRoot(),
    });
    assert.equal(result.source, "base");
    assert.equal(result.diverged, false);
    assert.deepEqual(result.selection.checks, installed.checks);
    assert.ok(result.selection.reason.some((r) => /RAD-167-R1/.test(r)));
  });

  it("167-R1 loop that narrows ci-select still gets the base plan for gating", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad167-narrow-"));
    try {
      await writeFakeWorktreeSelect(
        wt,
        `export function selectCiChecks(changedPaths) {
  return {
    checks: ["format:check"],
    reason: ["narrow worktree — should not gate"],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: false,
    skipped: false,
  };
}
`,
      );
      const result = await resolveCiSelection({
        changedPaths: ["packages/core/src/ci-select.ts"],
        worktreePath: wt,
        installedSelect: selectCiChecks,
        primaryPath: repoRoot(),
        loadBaseRefSelect: async () => scopedCoreSelectFn(),
      });
      assert.equal(result.source, "base");
      assert.ok(result.selection.checks.length > 1);
      assert.notDeepEqual(result.selection.checks, ["format:check"]);
    } finally {
      clearWorktreeCiSelectCache();
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("167-R2 reports diff when worktree selector differs from base", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad167-diff-"));
    try {
      await writeFakeWorktreeSelect(
        wt,
        `export function selectCiChecks(changedPaths) {
  return {
    checks: ["format:check"],
    reason: ["narrow advisory"],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: false,
    skipped: false,
  };
}
`,
      );
      const result = await resolveCiSelection({
        changedPaths: ["packages/core/src/git.ts"],
        worktreePath: wt,
        installedSelect: selectCiChecks,
        primaryPath: repoRoot(),
        loadBaseRefSelect: async () => scopedCoreSelectFn(),
      });
      assert.equal(result.diverged, true);
      assert.ok(result.warning);
      assert.ok(result.advisorySelection);
      assert.deepEqual(result.advisorySelection?.checks, ["format:check"]);
    } finally {
      clearWorktreeCiSelectCache();
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("167-R3 non-PR-Genie repo with ci-select path does not execute worktree module", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad167-host-"));
    try {
      await writeFile(
        path.join(wt, "package.json"),
        JSON.stringify({ name: "customer-app", private: true }),
      );
      const dir = path.join(wt, "packages", "core", "src");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "ci-select.ts"),
        `export function selectCiChecks() {
  throw new Error("must not execute host ci-select");
}
`,
      );
      assert.equal(isPrGenieRepo(wt), false);
      let executed = false;
      const result = await resolveCiSelection({
        changedPaths: ["packages/core/src/ci-select.ts"],
        worktreePath: wt,
        installedSelect: () => {
          executed = true;
          return selectCiChecks(["packages/core/src/git.ts"]);
        },
        loadWorktreeSelect: async () => {
          throw new Error("must not load worktree select for host repo");
        },
      });
      assert.ok(executed);
      assert.equal(result.source, "installed");
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("loads real worktree selectCiChecks via tsx (printable plan matches unit tests)", async () => {
    clearWorktreeCiSelectCache();
    const paths = ["packages/core/src/ci-select.ts", "docs/ci-checks.md"];
    const expected = selectCiChecks(paths);
    const loaded = await loadWorktreeSelectCiChecks(repoRoot(), { primaryPath: repoRoot() });
    assert.ok(loaded);
    const fromWorktree = loaded!(paths);
    assert.deepEqual(fromWorktree.checks, expected.checks);
    assert.deepEqual(fromWorktree.reason, expected.reason);
  });

  it("167-R1 base loader keeps detached worktree for CLI fallback after dead tsImport", async () => {
    clearWorktreeCiSelectCache();
    const gitRoot = repoRoot();
    const baseFn = await loadBaseRefSelectCiChecks(gitRoot, "main", gitRoot, {
      tsImport: async () => {
        throw new Error("The service is no longer running");
      },
    });
    assert.ok(baseFn, "expected base-commit select via CLI fallback");
    const plan = baseFn!(["packages/core/src/git.ts"]);
    assert.ok(plan.checks.length > 0);
    assert.ok(!plan.checks.includes("test"));
    clearWorktreeCiSelectCache();
  });

  it("167-R1 does not stamp base provenance when base loader returns null", async () => {
    clearWorktreeCiSelectCache();
    const wt = await mkdtemp(path.join(tmpdir(), "prgenie-rad167-null-base-"));
    try {
      await writeFakeWorktreeSelect(
        wt,
        `export function selectCiChecks(changedPaths) {
  return {
    checks: ["format:check"],
    reason: ["narrow worktree"],
    mapping: [],
    uncertain: false,
    changedPaths,
    packageScoped: false,
    skipped: false,
  };
}
`,
      );
      const result = await resolveCiSelection({
        changedPaths: ["packages/core/src/git.ts"],
        worktreePath: wt,
        installedSelect: () => scopedCoreSelect(["packages/core/src/git.ts"]),
        primaryPath: repoRoot(),
        loadBaseRefSelect: async () => null,
      });
      assert.equal(result.source, "installed");
      assert.ok(
        !result.selection.reason.some((r) => /RAD-167-R1: export gate uses base-commit/i.test(r)),
        "must not claim base selector when base load failed",
      );
    } finally {
      clearWorktreeCiSelectCache();
      await rm(wt, { recursive: true, force: true });
    }
  });
});
