import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCiPath,
  DEFAULT_CI_CHECKS,
  formatCiSelectionReason,
  isPackageScopedCheck,
  packageFromCiPath,
  selectCiChecks,
  shouldScopeFormatCheck,
} from "./ci-select.js";
import { ciCheckCommand } from "./progress.js";

describe("selectCiChecks", () => {
  it("runs the full suite when paths are empty or unknown (uncertain → full)", () => {
    const empty = selectCiChecks([]);
    assert.equal(empty.uncertain, true);
    assert.deepEqual(empty.checks, [...DEFAULT_CI_CHECKS]);
    assert.ok(empty.reason.some((r) => /uncertain → full/.test(r)));
    assert.ok(empty.reason.some((r) => /no changed paths/.test(r)));

    const unknown = selectCiChecks(["assets/logo.png"]);
    assert.equal(unknown.uncertain, true);
    assert.deepEqual(unknown.checks, [...DEFAULT_CI_CHECKS]);
    assert.ok(unknown.reason.some((r) => /uncertain → full/.test(r)));
  });

  it("selects format only for docs/markdown-only diffs", () => {
    const result = selectCiChecks(["README.md", "docs/architecture.md", "LICENSE"]);
    assert.equal(result.uncertain, false);
    assert.deepEqual(result.checks, ["format:check"]);
    assert.ok(result.reason.some((r) => /docs\/markdown-only/.test(r)));
    assert.ok(!result.checks.includes("test"));
    assert.ok(!result.checks.includes("lint"));
    assert.ok(!result.checks.some((c) => c === "test" || c.startsWith("test:")));
  });

  it("runs the full suite when config or CI scripts change", () => {
    const result = selectCiChecks(["package.json", "README.md"]);
    assert.equal(result.uncertain, false);
    assert.deepEqual(result.checks, [...DEFAULT_CI_CHECKS]);
    assert.ok(result.reason.some((r) => /config\/CI/.test(r)));
  });

  it("maps packages/core-only (+ docs) to scoped core lint/typecheck/unit — not full pnpm test", () => {
    const result = selectCiChecks(["packages/core/src/ci-select.ts", "docs/ci-checks.md"]);
    assert.equal(result.uncertain, false);
    assert.equal(result.packageScoped, true);
    assert.deepEqual(result.checks, ["format:check", "lint:core", "typecheck:core", "test:core"]);
    assert.ok(!result.checks.includes("test"));
    assert.ok(!result.checks.includes("build"));
    assert.ok(result.reason.some((r) => /packages\/core\/\*\*/.test(r)));
    assert.ok(result.reason.some((r) => /not full monorepo pnpm test/.test(r)));
    assert.ok(result.reason.some((r) => /fail-fast/.test(r)));
  });

  it("maps packages/cli source to scoped cli suite", () => {
    const result = selectCiChecks(["packages/cli/src/cli.ts"]);
    assert.equal(result.uncertain, false);
    assert.equal(result.packageScoped, true);
    assert.deepEqual(result.checks, ["format:check", "lint:cli", "typecheck:cli", "test:cli"]);
    assert.ok(result.reason.some((r) => /packages\/cli\/\*\*/.test(r)));
  });

  it("maps mixed core+cli to ordered per-package suites (stop after first package fail)", () => {
    const result = selectCiChecks(["packages/core/src/ci-select.ts", "packages/cli/src/cli.ts"]);
    assert.equal(result.packageScoped, true);
    assert.deepEqual(result.checks, [
      "format:check",
      "lint:core",
      "typecheck:core",
      "test:core",
      "lint:cli",
      "typecheck:cli",
      "test:cli",
    ]);
    assert.ok(result.reason.some((r) => /fail-fast: stop after first package suite fail/.test(r)));
  });

  it("docs-only skips units; uncertain mixed paths go full", () => {
    const docs = selectCiChecks(["docs/ci-checks.md"]);
    assert.deepEqual(docs.checks, ["format:check"]);
    assert.equal(docs.uncertain, false);

    const mixed = selectCiChecks(["README.md", "bin/mystery.bin"]);
    assert.equal(mixed.uncertain, true);
    assert.deepEqual(mixed.checks, [...DEFAULT_CI_CHECKS]);
    assert.ok(mixed.reason.some((r) => /uncertain → full/.test(r)));
  });

  it("treats non-scopable package source as uncertain → full", () => {
    const result = selectCiChecks(["packages/plugin/hooks/capture-subagent.cjs"]);
    assert.equal(result.uncertain, true);
    assert.deepEqual(result.checks, [...DEFAULT_CI_CHECKS]);
    assert.ok(result.reason.some((r) => /uncertain → full/.test(r)));
  });

  it("ignores bundled plugin hooks/mcp .cjs when scoping with core/cli", () => {
    const result = selectCiChecks([
      "packages/core/src/git.ts",
      "packages/plugin/hooks/capture-subagent.cjs",
      "packages/plugin/mcp/server.cjs",
      "packages/plugin/skills/start/SKILL.md",
    ]);
    assert.equal(result.uncertain, false);
    assert.equal(result.packageScoped, true);
    assert.deepEqual(result.checks, ["format:check", "lint:core", "typecheck:core", "test:core"]);
  });

  it("classifies test, source, docs, and config paths", () => {
    assert.equal(classifyCiPath("packages/core/src/ci-select.test.ts"), "test");
    assert.equal(classifyCiPath("packages/core/src/ci-select.ts"), "source");
    assert.equal(classifyCiPath("docs/ci-checks.md"), "docs");
    assert.equal(classifyCiPath("packages/plugin/rules/no-remote-pr.mdc"), "docs");
    assert.equal(classifyCiPath(".github/workflows/ci.yml"), "config");
    assert.equal(classifyCiPath("scripts/build.mjs"), "config");
    assert.equal(packageFromCiPath("packages/core/src/ci-select.ts"), "core");
    assert.equal(isPackageScopedCheck("lint:core"), true);
    assert.equal(isPackageScopedCheck("test"), false);
  });

  it("shouldScopeFormatCheck is true for package-scoped and docs-only plans only", () => {
    assert.equal(shouldScopeFormatCheck(selectCiChecks(["packages/core/src/ci-select.ts"])), true);
    assert.equal(shouldScopeFormatCheck(selectCiChecks(["docs/ci-checks.md"])), true);
    assert.equal(shouldScopeFormatCheck(selectCiChecks(["package.json"])), false);
    assert.equal(shouldScopeFormatCheck(selectCiChecks(["assets/logo.png"])), false);
    assert.equal(shouldScopeFormatCheck(selectCiChecks([])), false);
    assert.equal(shouldScopeFormatCheck(undefined), false);
  });

  it("formats reason arrays for cards and maps scoped commands away from pnpm test", () => {
    assert.equal(formatCiSelectionReason(["a", "b"]), "a; b");
    assert.equal(formatCiSelectionReason("legacy"), "legacy");
    assert.equal(ciCheckCommand("test"), "pnpm test");
    assert.equal(ciCheckCommand("lint:core"), "pnpm exec eslint packages/core/src");
    assert.equal(ciCheckCommand("typecheck:core"), "pnpm exec tsc -p packages/core --noEmit");
    assert.equal(ciCheckCommand("test:core"), "pnpm exec tsx --test packages/core/src/*.test.ts");
    assert.notEqual(ciCheckCommand("test:core"), "pnpm test");
  });

  it("resolveCiCwd prefers the loop worktree over primary/plugin cwd", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { resolveCiCwd, isCursorPluginInstallPath } = await import("./ci-select.js");
    const worktree = await mkdtemp(path.join(tmpdir(), "prgenie-ci-wt-"));
    const primary = await mkdtemp(path.join(tmpdir(), "prgenie-ci-primary-"));
    try {
      await writeFile(path.join(worktree, ".keep"), "");
      assert.equal(resolveCiCwd(primary, worktree), worktree);

      const plugin = path.join(tmpdir(), ".cursor", "plugins", "local", "prgenie-fake");
      assert.equal(isCursorPluginInstallPath(plugin), true);
      assert.equal(resolveCiCwd(plugin, worktree), worktree);

      assert.throws(() => resolveCiCwd(plugin, null), /stale plugin build|wrong tree/);
      assert.throws(
        () => resolveCiCwd(plugin, path.join(tmpdir(), "missing-worktree")),
        /stale plugin build|wrong tree/,
      );
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(primary, { recursive: true, force: true });
    }
  });
});
