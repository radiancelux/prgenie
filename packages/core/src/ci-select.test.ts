import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCiPath,
  DEFAULT_CI_CHECKS,
  formatCiSelectionReason,
  isHardConfigPath,
  isIncidentalPluginMeta,
  isPackageScopedCheck,
  packageFromCiPath,
  selectCiChecks,
  shouldScopeFormatCheck,
  expandFailingChecks,
} from "./ci-select.js";
import { ciCheckCommand } from "./progress.js";

function assertNotFullSuite(result: ReturnType<typeof selectCiChecks>): void {
  assert.notDeepEqual(result.checks, [...DEFAULT_CI_CHECKS]);
  assert.ok(!result.checks.includes("test"));
  assert.ok(!result.checks.includes("build"));
  assert.ok(!result.reason.some((r) => /uncertain → full/.test(r)));
  assert.ok(!result.reason.some((r) => /running full suite/.test(r)));
}

describe("selectCiChecks", () => {
  it("skips (never full suite) when paths are empty or unknown (RAD-119)", () => {
    const empty = selectCiChecks([]);
    assert.equal(empty.uncertain, true);
    assert.equal(empty.skipped, true);
    assert.deepEqual(empty.checks, []);
    assert.ok(empty.reason.some((r) => /no changed paths/.test(r)));
    assert.ok(empty.reason.some((r) => /skip local CI/.test(r)));
    assertNotFullSuite(empty);

    const unknown = selectCiChecks(["assets/logo.png"]);
    assert.equal(unknown.uncertain, true);
    assert.equal(unknown.skipped, true);
    assert.deepEqual(unknown.checks, []);
    assert.ok(unknown.reason.some((r) => /uncertain path mapping/.test(r)));
    assert.ok(unknown.reason.some((r) => /skip local CI/.test(r)));
    assertNotFullSuite(unknown);
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

  it("skips (never full suite) when hard config or CI scripts change (RAD-119)", () => {
    const result = selectCiChecks(["package.json", "README.md"]);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.checks, []);
    assert.ok(result.reason.some((r) => /config\/CI/.test(r)));
    assert.ok(result.reason.some((r) => /skip local CI/.test(r)));
    assertNotFullSuite(result);
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

  it("docs-only skips units; unknown mixed paths skip (never full suite)", () => {
    const docs = selectCiChecks(["docs/ci-checks.md"]);
    assert.deepEqual(docs.checks, ["format:check"]);
    assert.equal(docs.uncertain, false);

    const mixed = selectCiChecks(["README.md", "bin/mystery.bin"]);
    assert.equal(mixed.uncertain, true);
    assert.equal(mixed.skipped, true);
    assert.deepEqual(mixed.checks, []);
    assert.ok(mixed.reason.some((r) => /skip local CI/.test(r)));
    assertNotFullSuite(mixed);
  });

  it("plugin build artifacts alone skip — never uncertain → full suite (RAD-119)", () => {
    const result = selectCiChecks(["packages/plugin/hooks/capture-subagent.cjs"]);
    assert.equal(result.skipped, true);
    assert.deepEqual(result.checks, []);
    assert.ok(result.reason.some((r) => /plugin build artifacts only/.test(r)));
    assertNotFullSuite(result);
  });

  it("routine plugin source maps to thin plugin suite (format only)", () => {
    const result = selectCiChecks([
      "packages/plugin/skills/start/SKILL.md",
      "packages/plugin/hooks/session-log.mjs",
    ]);
    assert.equal(result.uncertain, false);
    assert.equal(result.skipped, false);
    assert.deepEqual(result.checks, ["format:check"]);
    assert.ok(result.reason.some((r) => /thin plugin suite/.test(r)));
    assertNotFullSuite(result);
  });

  it("incidental plugin.json / mcp.json / hooks.json do not force config skip when core is scoped", () => {
    assert.equal(isIncidentalPluginMeta("packages/plugin/.cursor-plugin/plugin.json"), true);
    assert.equal(isIncidentalPluginMeta("packages/plugin/mcp.json"), true);
    assert.equal(isIncidentalPluginMeta("packages/plugin/hooks/hooks.json"), true);
    assert.equal(isHardConfigPath("packages/plugin/mcp.json"), false);
    assert.equal(isHardConfigPath("package.json"), true);

    const result = selectCiChecks([
      "packages/core/src/ci-select.ts",
      "packages/plugin/.cursor-plugin/plugin.json",
      "packages/plugin/mcp.json",
      "packages/plugin/hooks/hooks.json",
    ]);
    assert.equal(result.packageScoped, true);
    assert.deepEqual(result.checks, ["format:check", "lint:core", "typecheck:core", "test:core"]);
    assertNotFullSuite(result);
  });

  it("plugin metadata alone is docs/style → format:check (not config full suite)", () => {
    const result = selectCiChecks([
      "packages/plugin/.cursor-plugin/plugin.json",
      "packages/plugin/mcp.json",
    ]);
    assert.equal(result.uncertain, false);
    assert.deepEqual(result.checks, ["format:check"]);
    assertNotFullSuite(result);
  });

  it("scopes package-local package.json under packages/core to core suite", () => {
    const result = selectCiChecks(["packages/core/package.json", "packages/core/src/git.ts"]);
    assert.equal(result.packageScoped, true);
    assert.deepEqual(result.checks, ["format:check", "lint:core", "typecheck:core", "test:core"]);
    assertNotFullSuite(result);
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
    assert.equal(classifyCiPath("packages/plugin/mcp.json"), "style");
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

  it("expandFailingChecks maps root test/lint to package scopes; skip plans keep resume names", () => {
    const core = selectCiChecks(["packages/core/src/ci-select.ts"]);
    assert.deepEqual(expandFailingChecks(["test"], core), ["test:core"]);
    assert.deepEqual(expandFailingChecks(["lint", "typecheck"], core), [
      "lint:core",
      "typecheck:core",
    ]);
    const skipped = selectCiChecks(["package.json"]);
    assert.equal(skipped.skipped, true);
    // CI-resume must keep named checks on a skip plan (not greenwash via empty + skipped).
    assert.deepEqual(expandFailingChecks(["test", "lint", "format:check"], skipped), [
      "test",
      "lint",
      "format:check",
    ]);
  });

  it("formats reason arrays for cards and maps scoped commands away from pnpm test", () => {
    assert.equal(formatCiSelectionReason(["a", "b"]), "a; b");
    assert.equal(formatCiSelectionReason("legacy"), "legacy");
    assert.equal(ciCheckCommand("test"), "pnpm test");
    assert.equal(ciCheckCommand("lint:core"), "pnpm exec eslint packages/core/src");
    assert.equal(ciCheckCommand("typecheck:core"), "pnpm exec tsc -p packages/core --noEmit");
    assert.equal(ciCheckCommand("test:core"), "pnpm exec tsx --test packages/core/src/*.test.ts");
    assert.equal(
      ciCheckCommand("test:core", ["packages/core/src/progress.test.ts"]),
      "pnpm exec tsx --test packages/core/src/progress.test.ts",
    );
    assert.notEqual(ciCheckCommand("test:core"), "pnpm test");
  });

  it("file-scopes test:core for leaf progress.ts; keeps glob for prs/export-gate (RAD-127)", () => {
    const leaf = selectCiChecks(["packages/core/src/progress.ts"]);
    assert.equal(leaf.packageScoped, true);
    assert.deepEqual(leaf.checks, ["format:check", "lint:core", "typecheck:core", "test:core"]);
    assert.deepEqual(leaf.testFiles?.["test:core"], ["packages/core/src/progress.test.ts"]);
    assert.ok(leaf.reason.some((r) => /file-scoped test:core/.test(r)));
    assert.ok(leaf.reason.some((r) => /progress\.test\.ts/.test(r)));
    assert.equal(
      ciCheckCommand("test:core", leaf.testFiles?.["test:core"]),
      "pnpm exec tsx --test packages/core/src/progress.test.ts",
    );
    // --failing test:core re-selects from the same paths → same file list.
    const resume = selectCiChecks(["packages/core/src/progress.ts"]);
    assert.deepEqual(expandFailingChecks(["test:core"], resume), ["test:core"]);
    assert.deepEqual(resume.testFiles?.["test:core"], leaf.testFiles?.["test:core"]);

    const prs = selectCiChecks(["packages/core/src/prs.ts"]);
    assert.equal(prs.packageScoped, true);
    assert.equal(prs.testFiles?.["test:core"], undefined);
    assert.ok(prs.reason.some((r) => /shared module surface/.test(r)));
    assert.ok(prs.reason.some((r) => /\*\.test\.ts/.test(r)));
    assert.equal(
      ciCheckCommand("test:core", prs.testFiles?.["test:core"]),
      ciCheckCommand("test:core"),
    );

    const gate = selectCiChecks(["packages/core/src/export-gate.ts"]);
    assert.equal(gate.testFiles?.["test:core"], undefined);
    assert.ok(gate.reason.some((r) => /shared module surface/.test(r)));

    const leafPlusTest = selectCiChecks([
      "packages/core/src/progress.ts",
      "packages/core/src/progress.test.ts",
    ]);
    assert.deepEqual(leafPlusTest.testFiles?.["test:core"], ["packages/core/src/progress.test.ts"]);
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
