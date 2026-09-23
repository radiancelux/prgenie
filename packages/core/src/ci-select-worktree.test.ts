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
  loadWorktreeSelectCiChecks,
  resolveCiSelection,
  touchesCiSelectionSource,
} from "./ci-select-worktree.js";
import type { CiCheckSelection } from "./ci-select.js";

function repoRoot(): string {
  return process.cwd();
}

async function writeFakeWorktreeSelect(root: string, body: string): Promise<void> {
  const dir = path.join(root, "packages", "core", "src");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fake-wt", private: true }),
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
      });

      assert.equal(result.source, "worktree");
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
      assert.ok(result.selection.reason.some((r) => /RAD-123.*diverged/.test(r)));
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
      });

      assert.equal(result.source, "worktree");
      assert.equal(result.diverged, true);
      assert.ok(result.warning);
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

  it("refuses when ci-select is touched but worktree module is missing", async () => {
    await assert.rejects(
      () =>
        resolveCiSelection({
          changedPaths: ["packages/core/src/ci-runner.ts"],
          worktreePath: path.join(tmpdir(), "prgenie-missing-wt-nope"),
          installedSelect: selectCiChecks,
        }),
      /Refusing stale installed CI selection/,
    );
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
    assert.equal(result.source, "worktree");
    assert.equal(result.diverged, false);
    assert.deepEqual(result.selection.checks, installed.checks);
    assert.ok(result.selection.reason.some((r) => /RAD-123: using worktree ci-select/.test(r)));
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
          loadWorktreeSelect: async () => null,
        }),
      /Refusing stale installed CI selection|full suite/,
    );
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
    assert.equal(result.source, "worktree");
    assert.equal(result.diverged, false);
    assert.deepEqual(result.selection.checks, installed.checks);
    assert.ok(result.selection.reason.some((r) => /RAD-123: using worktree ci-select/.test(r)));
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
});
