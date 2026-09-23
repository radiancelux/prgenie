import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { abortExportGate } from "./export-validation.js";
import {
  resolvePrettierFromCwd,
  resolveFormatCheckFiles,
  runCiChecks,
  runLoopCi,
} from "./ci-runner.js";
import { selectCiChecks, shouldScopeFormatCheck } from "./ci-select.js";
import { git } from "./git.js";
import { isAbortError } from "./progress.js";
import { createLocalPr } from "./prs.js";

const execAsync = promisify(exec);

/**
 * Create a cross-platform symlink to node_modules.
 * On Windows, uses junction which doesn't require admin privileges.
 * On Unix, uses a standard symlink.
 */
async function linkNodeModules(targetDir: string, sourceModulesPath: string): Promise<void> {
  const linkPath = join(targetDir, "node_modules");
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(sourceModulesPath, linkPath, type);
}

async function initTestRepo(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-test-"));
  // Create a minimal package.json with scripts that will pass
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: {
        "format:check": "exit 0",
        lint: "exit 0",
        typecheck: "exit 0",
        test: "exit 0",
        build: "exit 0",
      },
    }),
  );
  return tmp;
}

describe("resolvePrettierFromCwd", () => {
  it("resolves prettier from the CI cwd, not the calling module path", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-prettier-cwd-"));
    const fakePlugin = await mkdtemp(join(tmpdir(), "prgenie-fake-plugin-"));
    try {
      await writeFile(join(repo, "package.json"), JSON.stringify({ name: "ci-cwd" }));
      await linkNodeModules(repo, join(process.cwd(), "node_modules"));
      // Isolated plugin tree with package.json but no prettier (mirrors ~/.cursor/plugins/...).
      await mkdir(join(fakePlugin, "mcp"), { recursive: true });
      await writeFile(join(fakePlugin, "package.json"), JSON.stringify({ name: "fake-plugin" }));
      await writeFile(join(fakePlugin, "mcp", "server.cjs"), "module.exports = {};\n");

      const fromCwd = resolvePrettierFromCwd(repo);
      assert.match(fromCwd, /prettier/);

      const requireFromPlugin = createRequire(join(fakePlugin, "mcp", "server.cjs"));
      assert.throws(() => requireFromPlugin.resolve("prettier"), /Cannot find module/);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
      await rm(fakePlugin, { recursive: true, force: true });
    }
  });
});

describe("runCiChecks", () => {
  it("returns all passed when all checks succeed", async () => {
    const repo = await initTestRepo();
    try {
      // Generous timeout: under parallel node:test load, spawning five shells can exceed 5s.
      const result = await runCiChecks(repo, { timeout: 60_000, parallel: false });

      assert.equal(result.allPassed, true);
      assert.equal(result.checks.length, 5);
      assert.ok(result.checks.every((c) => c.passed));

      const checkNames = result.checks.map((c) => c.name);
      assert.ok(checkNames.includes("format:check"));
      assert.ok(checkNames.includes("lint"));
      assert.ok(checkNames.includes("typecheck"));
      assert.ok(checkNames.includes("test"));
      assert.ok(checkNames.includes("build"));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns failed check when one check fails", async () => {
    const repo = await initTestRepo();
    try {
      // Override to make lint fail
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 1",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      const result = await runCiChecks(repo, {
        timeout: 60_000,
        failFast: false,
        parallel: false,
      });

      assert.equal(result.allPassed, false);
      const lintCheck = result.checks.find((c) => c.name === "lint");
      assert.ok(lintCheck);
      assert.equal(lintCheck.passed, false);
      assert.ok(lintCheck.error);

      // Other checks should still pass when fail-fast is off
      const passedChecks = result.checks.filter((c) => c.name !== "lint");
      assert.ok(
        passedChecks.every((c) => c.passed),
        `expected non-lint checks to pass, got ${JSON.stringify(passedChecks)}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns multiple failed checks when multiple checks fail", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 1",
            lint: "exit 0",
            typecheck: "exit 1",
            test: "exit 0",
            build: "exit 1",
          },
        }),
      );

      const result = await runCiChecks(repo, {
        timeout: 60_000,
        failFast: false,
        parallel: false,
      });

      assert.equal(result.allPassed, false);

      const failedChecks = result.checks.filter((c) => !c.passed && !c.skipped);
      assert.equal(failedChecks.length, 3);

      const failedNames = failedChecks.map((c) => c.name);
      assert.ok(failedNames.includes("format:check"));
      assert.ok(failedNames.includes("typecheck"));
      assert.ok(failedNames.includes("build"));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("accepts custom checks array", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "custom-check": "exit 0",
          },
        }),
      );

      const result = await runCiChecks(repo, {
        checks: ["custom-check"],
        timeout: 5000,
      });

      assert.equal(result.allPassed, true);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].name, "custom-check");
      assert.equal(result.checks[0].passed, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("handles missing script as failure", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {},
        }),
      );

      const result = await runCiChecks(repo, {
        checks: ["nonexistent"],
        timeout: 5000,
      });

      assert.equal(result.allPassed, false);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0].passed, false);
      assert.ok(result.checks[0].error);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-36: format:check must ignore untracked junk (match clean-checkout remote CI)
  // Note: This test uses workspace-level prettier installation
  it("RAD-36: format:check ignores untracked files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-rad36-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json that uses workspace prettier via pnpm link
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          packageManager: "pnpm@10.33.0",
          scripts: {
            lint: "exit 0",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      // Create .gitignore to exclude node_modules from tracking
      await writeFile(join(repo, ".gitignore"), "node_modules\n");

      // Create .prettierignore to exclude files that can't be formatted
      await writeFile(join(repo, ".prettierignore"), ".gitignore\nnode_modules\n");

      // Link to workspace node_modules for prettier access
      await linkNodeModules(repo, join(process.cwd(), "node_modules"));

      // Create .prettierrc.json
      await writeFile(
        join(repo, ".prettierrc.json"),
        JSON.stringify({
          semi: true,
          singleQuote: false,
          trailingComma: "all",
        }),
      );

      // Create a properly formatted tracked file
      await writeFile(join(repo, "good.js"), 'const x = "hello";\n');

      // Format all files before committing
      await execAsync("pnpm exec prettier --write .", { cwd: repo });

      // Track and commit the good files
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // Create an untracked file with bad formatting (missing semicolon)
      await writeFile(join(repo, "untracked-junk.js"), 'const bad = "untracked"\n');

      // Run format:check - should PASS because untracked file is ignored
      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        timeout: 10000,
      });

      assert.equal(result.allPassed, true, "format:check should pass despite untracked junk");
      const formatCheck = result.checks.find((c) => c.name === "format:check");
      assert.ok(formatCheck);
      assert.equal(formatCheck.passed, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-36: format:check still fails on tracked format violations", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-rad36-fail-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json that uses workspace prettier via pnpm link
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          packageManager: "pnpm@10.33.0",
          scripts: {
            lint: "exit 0",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      // Create .gitignore to exclude node_modules from tracking
      await writeFile(join(repo, ".gitignore"), "node_modules\n");

      // Create .prettierignore to exclude files that can't be formatted
      await writeFile(join(repo, ".prettierignore"), ".gitignore\nnode_modules\n");

      // Link to workspace node_modules for prettier access
      await linkNodeModules(repo, join(process.cwd(), "node_modules"));

      // Create .prettierrc.json
      await writeFile(
        join(repo, ".prettierrc.json"),
        JSON.stringify({
          semi: true,
          singleQuote: false,
          trailingComma: "all",
        }),
      );

      // Create a tracked file with bad formatting (missing semicolon)
      await writeFile(join(repo, "bad.js"), 'const bad = "tracked"\n');

      // Format JSON files but leave bad.js unformatted
      await execAsync("pnpm exec prettier --write package.json .prettierrc.json", {
        cwd: repo,
      });

      // Track and commit
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // Run format:check - should FAIL because tracked file has format issue
      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        timeout: 10000,
      });

      assert.equal(result.allPassed, false, "format:check should fail on tracked violations");
      const formatCheck = result.checks.find((c) => c.name === "format:check");
      assert.ok(formatCheck);
      assert.equal(formatCheck.passed, false);
      assert.ok(formatCheck.error, "should have error message");
      assert.match(
        formatCheck.excerpt ?? formatCheck.error ?? "",
        /bad\.js|Prettier format check failed/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-46: format:check must pass on Windows autocrlf when git blob (LF) is clean
  it("RAD-46: format:check passes when working tree is CRLF but blob is LF", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-rad46-crlf-"));
    try {
      // Init git repo with autocrlf enabled (simulates Windows)
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });
      await execAsync("git config core.autocrlf true", { cwd: repo });

      // Create package.json
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          packageManager: "pnpm@10.33.0",
          scripts: {
            lint: "exit 0",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      // Create .gitignore and .prettierignore
      await writeFile(join(repo, ".gitignore"), "node_modules\n");
      await writeFile(join(repo, ".prettierignore"), ".gitignore\nnode_modules\n");

      // Link to workspace node_modules for prettier access
      await linkNodeModules(repo, join(process.cwd(), "node_modules"));

      // Create .prettierrc.json with LF line ending requirement
      await writeFile(
        join(repo, ".prettierrc.json"),
        JSON.stringify({
          semi: true,
          singleQuote: false,
          trailingComma: "all",
          endOfLine: "lf",
        }),
      );

      // Create a properly formatted JS file with LF endings
      const goodContent = 'const x = "hello";\n';
      await writeFile(join(repo, "good.js"), goodContent);

      // Format all files before committing
      await execAsync("pnpm exec prettier --write .", { cwd: repo });

      // Stage and commit - git will store as LF in blob
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // Simulate autocrlf checkout: convert LF to CRLF in working tree
      // Read the blob content and write back with CRLF
      const workingTreeContent = goodContent.replace(/\n/g, "\r\n");
      await writeFile(join(repo, "good.js"), workingTreeContent);

      // Verify working tree now has CRLF - git diff should be empty due to autocrlf normalization
      // But we can verify the file physically has CRLF in working tree
      const fs = await import("node:fs/promises");
      const physicalContent = await fs.readFile(join(repo, "good.js"), "utf8");
      assert.ok(
        physicalContent.includes("\r\n"),
        "Working tree file should have CRLF line endings",
      );

      // Run format:check - should PASS because blob content (LF) is properly formatted
      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        timeout: 10000,
      });

      assert.equal(
        result.allPassed,
        true,
        "format:check should pass when blob is LF-formatted despite CRLF working tree",
      );
      const formatCheck = result.checks.find((c) => c.name === "format:check");
      assert.ok(formatCheck);
      assert.equal(formatCheck.passed, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-117: scoped format:check only blob-checks changed prettier paths
  async function initFormatScopeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-rad117-"));
    await execAsync("git init", { cwd: repo });
    await execAsync('git config user.email "test@test.com"', { cwd: repo });
    await execAsync('git config user.name "Test"', { cwd: repo });
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await writeFile(join(repo, ".prettierignore"), ".gitignore\nnode_modules\n");
    await writeFile(
      join(repo, ".prettierrc.json"),
      JSON.stringify({ semi: true, singleQuote: false, trailingComma: "all", endOfLine: "lf" }),
    );
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        name: "test-repo",
        packageManager: "pnpm@10.33.0",
        scripts: {
          "format:check": "exit 0",
          lint: "exit 0",
          typecheck: "exit 0",
          test: "exit 0",
          build: "exit 0",
        },
      }),
    );
    await linkNodeModules(repo, join(process.cwd(), "node_modules"));
    // Many tracked prettier files (full-tree would check all of these).
    await mkdir(join(repo, "packages", "core", "src"), { recursive: true });
    await mkdir(join(repo, "packages", "cli", "src"), { recursive: true });
    await mkdir(join(repo, "docs"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      await writeFile(join(repo, `filler-${i}.js`), `const n${i} = ${i};\n`);
    }
    await writeFile(join(repo, "packages", "core", "src", "util.ts"), "export const u = 1;\n");
    await writeFile(join(repo, "packages", "cli", "src", "cli.ts"), "export const c = 1;\n");
    await writeFile(join(repo, "docs", "guide.md"), "# Guide\n");
    await writeFile(join(repo, "README.md"), "# Root\n");
    await execAsync("pnpm exec prettier --write .", { cwd: repo });
    await execAsync("git add .", { cwd: repo });
    await execAsync('git commit -m "init"', { cwd: repo });
    return repo;
  }

  it("RAD-117: core-only change formats N changed files, not the whole repo", async () => {
    const repo = await initFormatScopeRepo();
    try {
      const full = await resolveFormatCheckFiles(repo, { formatScoped: false });
      assert.ok(full.files.length >= 10, `expected a wide tracked tree, got ${full.files.length}`);

      await writeFile(join(repo, "packages", "core", "src", "util.ts"), "export const u = 2;\n");
      await execAsync("pnpm exec prettier --write packages/core/src/util.ts", { cwd: repo });
      await execAsync("git add packages/core/src/util.ts", { cwd: repo });
      await execAsync('git commit -m "core tweak"', { cwd: repo });

      const changedPaths = ["packages/core/src/util.ts"];
      const selection = selectCiChecks(changedPaths);
      assert.equal(selection.packageScoped, true);

      const scoped = await resolveFormatCheckFiles(repo, {
        changedPaths,
        formatScoped: true,
      });
      assert.equal(scoped.formatScoped, true);
      assert.deepEqual(scoped.files, ["packages/core/src/util.ts"]);
      assert.ok(
        scoped.files.length < full.files.length,
        `scoped ${scoped.files.length} must be less than full ${full.files.length}`,
      );

      const commands: string[] = [];
      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        changedPaths,
        selection,
        skipCache: true,
        skipToolchainEnsure: true,
        timeout: 15000,
        onProgress: (event) => {
          if (event.check === "format:check" && event.command) commands.push(event.command);
        },
      });
      assert.equal(result.allPassed, true);
      const formatCheck = result.checks.find((c) => c.name === "format:check");
      assert.ok(formatCheck?.reason?.includes("scoped 1 changed file"));
      assert.ok(commands.some((c) => /format:check \(blobs\)/.test(c)));
      assert.ok(commands.some((c) => /packages\/core\/src\/util\.ts/.test(c)));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-117: docs-only formats changed markdown only", async () => {
    const repo = await initFormatScopeRepo();
    try {
      await writeFile(join(repo, "docs", "guide.md"), "# Guide updated\n");
      await execAsync("pnpm exec prettier --write docs/guide.md", { cwd: repo });
      await execAsync("git add docs/guide.md", { cwd: repo });
      await execAsync('git commit -m "docs"', { cwd: repo });

      const changedPaths = ["docs/guide.md"];
      const selection = selectCiChecks(changedPaths);
      assert.deepEqual(selection.checks, ["format:check"]);

      const scoped = await resolveFormatCheckFiles(repo, {
        changedPaths,
        formatScoped: true,
      });
      assert.deepEqual(scoped.files, ["docs/guide.md"]);

      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        changedPaths,
        selection,
        skipCache: true,
        skipToolchainEnsure: true,
        timeout: 15000,
      });
      assert.equal(result.allPassed, true);
      assert.ok(result.checks[0]?.reason?.includes("scoped 1 changed file"));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-117: uncertain/config keeps full tracked prettier tree", async () => {
    const repo = await initFormatScopeRepo();
    try {
      const full = await resolveFormatCheckFiles(repo, { formatScoped: false });

      const configPaths = ["package.json"];
      const configSel = selectCiChecks(configPaths);
      assert.equal(shouldScopeFormatCheck(configSel), false);
      const configFiles = await resolveFormatCheckFiles(repo, {
        changedPaths: configPaths,
        formatScoped: shouldScopeFormatCheck(configSel),
      });
      assert.equal(configFiles.formatScoped, false);
      assert.equal(configFiles.files.length, full.files.length);

      const uncertainPaths = ["assets/logo.png"];
      // Create the unknown path as an untracked non-prettier file so selection stays uncertain.
      await mkdir(join(repo, "assets"), { recursive: true });
      await writeFile(join(repo, "assets", "logo.png"), "x");
      const uncertainSel = selectCiChecks(uncertainPaths);
      assert.equal(uncertainSel.uncertain, true);
      assert.equal(shouldScopeFormatCheck(uncertainSel), false);
      const uncertainFiles = await resolveFormatCheckFiles(repo, {
        changedPaths: uncertainPaths,
        formatScoped: false,
      });
      assert.equal(uncertainFiles.files.length, full.files.length);

      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        changedPaths: configPaths,
        selection: configSel,
        skipCache: true,
        skipToolchainEnsure: true,
        timeout: 15000,
      });
      assert.equal(result.allPassed, true);
      assert.ok(result.checks[0]?.reason?.includes(`full tree ${full.files.length} file`));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-117: scoped format does not pass when ls-files fails with non-empty candidates", async () => {
    // Non-git cwd: scoped candidates are non-empty, but argv git ls-files fails.
    // Must not treat that as "scoped 0 files" success (fail-open greenwash).
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-rad117-lsfail-"));
    try {
      await mkdir(join(repo, "packages", "core", "src"), { recursive: true });
      await writeFile(join(repo, "packages", "core", "src", "util.ts"), "export const u = 1;\n");
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            // Even a green package script must not be the only safety net — resolution must fail.
            "format:check": "exit 0",
          },
        }),
      );

      const changedPaths = ["packages/core/src/util.ts"];
      const selection = selectCiChecks(changedPaths);
      assert.equal(selection.packageScoped, true);
      assert.equal(shouldScopeFormatCheck(selection), true);

      await assert.rejects(
        () =>
          resolveFormatCheckFiles(repo, {
            changedPaths,
            formatScoped: true,
          }),
        /git ls-files failed for scoped format paths/,
      );

      const result = await runCiChecks(repo, {
        checks: ["format:check"],
        changedPaths,
        selection,
        skipCache: true,
        skipToolchainEnsure: true,
        timeout: 10000,
      });
      assert.equal(result.allPassed, false, "ls-files failure must not greenwash format:check");
      const formatCheck = result.checks.find((c) => c.name === "format:check");
      assert.ok(formatCheck);
      assert.equal(formatCheck.passed, false);
      assert.match(
        `${formatCheck.error ?? ""}\n${formatCheck.excerpt ?? ""}`,
        /ls-files failed for scoped format paths|git ls-files/i,
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Cross-platform delay for package.json scripts (Windows has no `sleep`).
  const nodeSleep = (ms: number) => `node -e "setTimeout(() => process.exit(0), ${ms})"`;

  // RAD-46: Verify timeout configuration works
  it("RAD-46: timeout configuration is respected", async () => {
    const repo = await initTestRepo();
    try {
      // Override test script to sleep longer than timeout
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            test: nodeSleep(3000),
          },
        }),
      );

      // Run with short timeout - should fail
      const result = await runCiChecks(repo, {
        checks: ["test"],
        timeout: 1000, // 1 second timeout
      });

      assert.equal(result.allPassed, false, "Should fail due to timeout");
      const testCheck = result.checks.find((c) => c.name === "test");
      assert.ok(testCheck);
      assert.equal(testCheck.passed, false);
      assert.ok(testCheck.error, "Should have timeout error");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-46: Verify default timeout is sufficient for long test suites
  it("RAD-46: default timeout allows for long test runs", async () => {
    const repo = await initTestRepo();
    try {
      // Override test script to simulate a test that takes 2 seconds
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            test: nodeSleep(2000),
          },
        }),
      );

      // Run with default timeout (20m) - should pass
      const result = await runCiChecks(repo, {
        checks: ["test"],
        // Don't specify timeout, use default
      });

      assert.equal(result.allPassed, true, "Should pass with default timeout");
      const testCheck = result.checks.find((c) => c.name === "test");
      assert.ok(testCheck);
      assert.equal(testCheck.passed, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-35: Cache hit skips check execution
  it("RAD-35: cache hit skips check execution and returns cached pass", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-hit-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json with a script that will fail if executed
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1", // Will fail if executed
          },
        }),
      );
      await writeFile(join(repo, "test.txt"), "content\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // First run - will fail
      const result1 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result1.allPassed, false, "First run should fail");

      // Fix the script to pass
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0", // Now passes
          },
        }),
      );
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Fix lint"', { cwd: repo });

      // Second run - should pass and cache the result
      const result2 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result2.allPassed, true, "Second run should pass");

      // Change script back to failing (but don't commit)
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1", // Would fail if executed
          },
        }),
      );

      // Third run - should use cache (pass) because git HEAD unchanged
      // The working tree change doesn't invalidate cache (only committed content matters)
      const result3 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result3.allPassed, true, "Third run should pass via cache (HEAD unchanged)");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-35: Cache miss when file content changes
  it("RAD-35: cache invalidates when tracked files change", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-invalidate-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json with passing check
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
          },
        }),
      );
      await writeFile(join(repo, "test.txt"), "initial\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // First run - should pass and cache
      const result1 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result1.allPassed, true);

      // Modify a file and commit
      await writeFile(join(repo, "test.txt"), "modified\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Modify file"', { cwd: repo });

      // Now make the check fail
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1", // Now fails
          },
        }),
      );
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Break lint"', { cwd: repo });

      // Second run - cache should be invalid, check should run and fail
      const result2 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result2.allPassed, false, "Cache should be invalid after file change");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-35: skipCache option forces check execution
  it("RAD-35: skipCache option bypasses cache", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-skip-cache-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
          },
        }),
      );
      await writeFile(join(repo, "test.txt"), "content\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // First run - should pass and cache
      const result1 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result1.allPassed, true);

      // Make check fail
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1",
          },
        }),
      );
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Break lint"', { cwd: repo });

      // Run with skipCache=false (default) - should use cache and pass
      const result2 = await runCiChecks(repo, {
        checks: ["lint"],
        timeout: 5000,
        skipCache: false,
      });
      // Cache is invalid due to file change, so this will actually run and fail
      assert.equal(result2.allPassed, false);

      // Fix the check
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
          },
        }),
      );
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Fix lint"', { cwd: repo });

      // Run and cache the pass
      const result3 = await runCiChecks(repo, { checks: ["lint"], timeout: 5000 });
      assert.equal(result3.allPassed, true);

      // Break it again
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1",
          },
        }),
      );
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Break lint again"', { cwd: repo });

      // Run with skipCache=true - should execute and fail
      const result4 = await runCiChecks(repo, {
        checks: ["lint"],
        timeout: 5000,
        skipCache: true,
      });
      assert.equal(result4.allPassed, false, "skipCache should force execution");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-35: Multiple checks can be cached independently
  it("RAD-35: maintains independent cache for each check", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-multi-cache-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json with multiple checks
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
            test: "exit 0",
            typecheck: "exit 0",
          },
        }),
      );
      await writeFile(join(repo, "test.txt"), "content\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // Run all checks - should pass and cache all
      const result1 = await runCiChecks(repo, {
        checks: ["lint", "test", "typecheck"],
        timeout: 5000,
      });
      assert.equal(result1.allPassed, true);

      // Second run - should use cache for all
      const result2 = await runCiChecks(repo, {
        checks: ["lint", "test", "typecheck"],
        timeout: 5000,
      });
      assert.equal(result2.allPassed, true);
      // All checks should pass via cache
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // RAD-35: Cache-write failure does not fail the check or create duplicate results
  it("RAD-35: cache-write failure does not mark check failed or duplicate results", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-write-fail-"));
    try {
      // Init git repo
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });

      // Create package.json with passing checks
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
            test: "exit 0",
          },
        }),
      );
      await writeFile(join(repo, "test.txt"), "content\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "Initial commit"', { cwd: repo });

      // Make cache directory read-only to simulate cache-write failure
      const path = await import("node:path");
      const gitCommonDir = await import("./git.js").then((m) => m.gitCommonDir);
      const common = await gitCommonDir(repo);
      const cacheDir = path.join(common, "agent-console", "ci-cache");
      const fs = await import("node:fs/promises");
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.chmod(cacheDir, 0o444); // Read-only

      // Run checks - should pass even though cache write fails
      const result = await runCiChecks(repo, {
        checks: ["lint", "test"],
        timeout: 5000,
      });

      // Restore permissions for cleanup
      await fs.chmod(cacheDir, 0o755);

      // Verify checks passed
      assert.equal(result.allPassed, true, "Checks should pass despite cache-write failure");
      assert.equal(result.checks.length, 2, "Should have exactly 2 results (no duplicates)");

      // Verify both checks show as passed
      const lintCheck = result.checks.find((c) => c.name === "lint");
      const testCheck = result.checks.find((c) => c.name === "test");
      assert.ok(lintCheck, "Should have lint check result");
      assert.ok(testCheck, "Should have test check result");
      assert.equal(lintCheck.passed, true, "lint should pass");
      assert.equal(testCheck.passed, true, "test should pass");
      assert.equal(lintCheck.error, undefined, "lint should have no error");
      assert.equal(testCheck.error, undefined, "test should have no error");
    } finally {
      // Ensure cleanup can happen
      const path = await import("node:path");
      const gitCommonDir = await import("./git.js").then((m) => m.gitCommonDir);
      try {
        const common = await gitCommonDir(repo);
        const cacheDir = path.join(common, "agent-console", "ci-cache");
        const fs = await import("node:fs/promises");
        await fs.chmod(cacheDir, 0o755).catch(() => undefined);
      } catch {
        // Ignore cleanup errors
      }
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("emits start/pass/fail progress with the check command", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 0",
            test: "exit 1",
          },
        }),
      );
      const events: string[] = [];
      const result = await runCiChecks(repo, {
        checks: ["lint", "test"],
        timeout: 5000,
        skipCache: true,
        failFast: true,
        parallel: false,
        onProgress: (event) => {
          if (!event.check) return;
          events.push(`${event.check}:${event.state}:${event.command ?? ""}`);
        },
      });
      assert.equal(result.allPassed, false);
      assert.deepEqual(events, [
        "lint:start:pnpm lint",
        "lint:pass:pnpm lint",
        "test:start:pnpm test",
        "test:fail:pnpm test",
      ]);
      const failed = result.checks.find((c) => c.name === "test");
      assert.ok(failed?.error?.includes("pnpm test"));
      assert.ok(failed?.excerpt, "failing check should carry a short excerpt");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-74: excerpt prefers the first failing test name and writes a log", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-excerpt-"));
    try {
      await execAsync("git init", { cwd: repo });
      await execAsync('git config user.email "test@test.com"', { cwd: repo });
      await execAsync('git config user.name "Test"', { cwd: repo });
      await writeFile(
        join(repo, "fail-test.mjs"),
        "process.stderr.write('not ok 1 - widget renders\\n'); process.exit(1);\n",
      );
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: { test: "node fail-test.mjs" },
        }),
      );
      await writeFile(join(repo, "README.md"), "x\n");
      await execAsync("git add .", { cwd: repo });
      await execAsync('git commit -m "init"', { cwd: repo });

      const events: { message?: string; logPath?: string }[] = [];
      const result = await runCiChecks(repo, {
        checks: ["test"],
        timeout: 5000,
        skipCache: true,
        onProgress: (event) => {
          if (event.state === "fail") {
            events.push({ message: event.message, logPath: event.logPath });
          }
        },
      });
      assert.equal(result.allPassed, false);
      const failed = result.checks.find((c) => c.name === "test");
      assert.ok(failed);
      assert.match(failed.excerpt ?? "", /widget renders/);
      assert.match(failed.error ?? "", /test/);
      assert.match(failed.error ?? "", /widget renders/);
      assert.match(failed.error ?? "", /full log:/);
      assert.ok(failed.logPath);
      assert.match(events[0]?.message ?? "", /widget renders/);
      assert.ok(events[0]?.logPath);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-74: lint/typecheck/build failures keep a truncated excerpt, not only Command failed", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "fail-lint.mjs"),
        "console.error('src/foo.ts\\n  3:1  error  Unexpected var  no-var'); process.exit(1);\n",
      );
      await writeFile(
        join(repo, "fail-tsc.mjs"),
        "console.error(\"src/foo.ts(3,1): error TS2322: Type 'string' is not assignable.\"); process.exit(1);\n",
      );
      await writeFile(
        join(repo, "fail-build.mjs"),
        "console.error('ERROR: esbuild failed with 1 error'); process.exit(1);\n",
      );
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "node fail-lint.mjs",
            typecheck: "node fail-tsc.mjs",
            build: "node fail-build.mjs",
          },
        }),
      );
      const result = await runCiChecks(repo, {
        checks: ["lint", "typecheck", "build"],
        timeout: 5000,
        skipCache: true,
        failFast: false,
        parallel: false,
      });
      assert.equal(result.allPassed, false);
      const lint = result.checks.find((c) => c.name === "lint");
      const typecheck = result.checks.find((c) => c.name === "typecheck");
      const build = result.checks.find((c) => c.name === "build");
      assert.match(lint?.excerpt ?? "", /no-var|foo\.ts/);
      assert.match(typecheck?.excerpt ?? "", /TS2322/);
      assert.match(build?.excerpt ?? "", /esbuild failed/);
      assert.ok(!(lint?.excerpt ?? "").startsWith("Command failed"));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("aborts a long-running check and does not finish remaining checks", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: 'node -e "setTimeout(() => {}, 30000)"',
            test: "exit 0",
          },
        }),
      );
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 80);
      await assert.rejects(
        () =>
          runCiChecks(repo, {
            checks: ["lint", "test"],
            timeout: 30000,
            skipCache: true,
            parallel: false,
            signal: ac.signal,
          }),
        (err: unknown) => isAbortError(err),
      );
      assert.ok(Date.now() - started < 8000, "abort should not wait out the check");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("caller abort during a parallel run rejects instead of returning skips", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: 'node -e "setTimeout(() => {}, 30000)"',
            test: "exit 0",
          },
        }),
      );
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 80);
      await assert.rejects(
        () =>
          runCiChecks(repo, {
            checks: ["lint", "test"],
            timeout: 30000,
            skipCache: true,
            parallel: true,
            signal: ac.signal,
            skipToolchainEnsure: true,
          }),
        (err: unknown) => isAbortError(err),
      );
      assert.ok(Date.now() - started < 8000, "abort should not wait out the check");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-77: fail-fast skips remaining checks after the first failure", async () => {
    const repo = await initTestRepo();
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );
      const result = await runCiChecks(repo, {
        checks: ["lint", "test", "build"],
        timeout: 5000,
        skipCache: true,
        failFast: true,
        parallel: false,
      });
      assert.equal(result.allPassed, false);
      assert.equal(result.checks.find((c) => c.name === "lint")?.passed, false);
      assert.equal(result.checks.find((c) => c.name === "test")?.skipped, true);
      assert.equal(result.checks.find((c) => c.name === "build")?.skipped, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-77: parallel runs independent checks", async () => {
    const repo = await initTestRepo();
    try {
      const started: string[] = [];
      const result = await runCiChecks(repo, {
        checks: ["lint", "test"],
        timeout: 5000,
        skipCache: true,
        failFast: false,
        parallel: true,
        onProgress: (event) => {
          if (event.check && event.state === "start") started.push(event.check);
        },
      });
      assert.equal(result.allPassed, true);
      assert.deepEqual(new Set(started), new Set(["lint", "test"]));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("host-repo eslint . runs path-scoped and progress shows changed paths (RAD-120)", async () => {
    const repo = await initTestRepo();
    try {
      await mkdir(join(repo, "apps", "mobile", "src"), { recursive: true });
      await writeFile(join(repo, "apps", "mobile", "src", "badge.ts"), "export {};\n");
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "host-phoenix-like",
          scripts: {
            "format:check": "exit 0",
            lint: "eslint .",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      const changedPaths = ["apps/mobile/src/badge.ts"];
      const commands: string[] = [];
      await runCiChecks(repo, {
        checks: ["lint"],
        changedPaths,
        selection: {
          checks: ["lint"],
          reason: ["changed paths outside scopable packages", "uncertain → full suite"],
          mapping: [{ check: "lint", reason: "root lint" }],
          uncertain: true,
          changedPaths,
          packageScoped: false,
        },
        skipCache: true,
        skipToolchainEnsure: true,
        timeout: 15000,
        onProgress: (event) => {
          if (event.check === "lint" && event.command) commands.push(event.command);
        },
      });

      assert.ok(commands.length > 0, "progress emitted a lint command");
      assert.match(commands[0], /pnpm exec eslint/);
      assert.match(commands[0], /apps\/mobile\/src\/badge\.ts/);
      assert.notEqual(commands[0], "pnpm lint");
      // Fixture may lack a working eslint bin; scoped command string is the contract.
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("host-repo config change fail-closes to full pnpm lint (RAD-120)", async () => {
    const repo = await initTestRepo();
    try {
      // package.json script exits 0; packageScripts still reports monorepo-wide eslint .
      // so resolve would scope unless fail-closed kicks in for config paths.
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "host-phoenix-like",
          scripts: { lint: "exit 0" },
        }),
      );
      const changedPaths = ["eslint.config.mjs", "apps/mobile/src/badge.ts"];
      const commands: string[] = [];
      const result = await runCiChecks(repo, {
        checks: ["lint"],
        changedPaths,
        packageScripts: { lint: "eslint ." },
        skipCache: true,
        skipToolchainEnsure: true,
        timeout: 5000,
        onProgress: (event) => {
          if (event.check === "lint" && event.state === "start" && event.command) {
            commands.push(event.command);
          }
        },
      });
      assert.equal(result.allPassed, true);
      assert.equal(commands[0], "pnpm lint");
      assert.ok(result.checks[0]?.reason?.includes("config/CI"));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("runLoopCi", () => {
  async function initGitRepo(): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), "prgenie-loop-ci-"));
    await git(tmp, ["init", "-b", "main"]);
    await git(tmp, ["config", "user.email", "test@example.com"]);
    await git(tmp, ["config", "user.name", "Test"]);
    await writeFile(join(tmp, "README.md"), "hi\n");
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "test-repo",
        scripts: {
          "format:check": "exit 0",
          lint: "exit 0",
          typecheck: "exit 0",
          test: "exit 0",
          build: "exit 0",
        },
      }),
    );
    await git(tmp, ["add", "."]);
    await git(tmp, ["commit", "-m", "init"]);
    return tmp;
  }

  it("merges failingChecks into the smart-selected set", async () => {
    const repo = await initGitRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "notes.md"), "docs only\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "docs"]);
      const pr = await createLocalPr(repo, { title: "Docs", body: "Body", base: "main" });
      const result = await runLoopCi(repo, pr.id, {
        failingChecks: ["lint", "test"],
        skipCache: true,
        timeout: 5000,
        skipToolchainEnsure: true,
      });
      const names = result.checks.map((c) => c.name);
      assert.ok(names.includes("format:check"), "docs-only still selects format");
      assert.ok(names.includes("lint"), "failingChecks merge lint");
      assert.ok(names.includes("test"), "failingChecks merge test");
      assert.ok(result.selection);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("maps CI-resume failingChecks test to test:core on package-scoped plans", async () => {
    const repo = await initGitRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await mkdir(join(repo, "packages", "core", "src"), { recursive: true });
      await writeFile(join(repo, "packages", "core", "src", "util.ts"), "export const u = 1;\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "core"]);
      const pr = await createLocalPr(repo, { title: "Core", body: "Body", base: "main" });
      const result = await runLoopCi(repo, pr.id, {
        failingChecks: ["test"],
        skipCache: true,
        timeout: 5000,
        skipToolchainEnsure: true,
        // Only run the resume-mapped check; scripts exit 0 via package.json from initGitRepo.
        checks: undefined,
      });
      const names = result.checks.map((c) => c.name);
      assert.ok(names.includes("test:core"), "resume test → test:core");
      assert.ok(!names.includes("test"), "must not force root pnpm test");
      assert.equal(result.selection?.packageScoped, true);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("aborts when abortExportGate bumps the shared token", async () => {
    const repo = await initGitRepo();
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
      await git(repo, ["commit", "-m", "code"]);
      const pr = await createLocalPr(repo, { title: "Code", body: "Body", base: "main" });
      const started = Date.now();
      setTimeout(() => abortExportGate(repo, pr.id), 80);
      await assert.rejects(
        () =>
          runLoopCi(repo, pr.id, {
            checks: ["lint"],
            skipCache: true,
            timeout: 30000,
            parallel: false,
            skipToolchainEnsure: true,
          }),
        (err: unknown) => isAbortError(err),
      );
      assert.ok(Date.now() - started < 8000);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("runs CI in the loop worktree and returns that cwd (RAD-112)", async () => {
    const repo = await initGitRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "notes.md"), "docs\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "docs"]);
      const pr = await createLocalPr(repo, { title: "Docs", body: "Body", base: "main" });
      assert.ok(pr.worktreePath, "createLocalPr should bind a worktree");
      const seen: string[] = [];
      const result = await runLoopCi(repo, pr.id, {
        checks: ["format:check"],
        skipCache: true,
        timeout: 5000,
        skipToolchainEnsure: true,
        onProgress: (event) => {
          if (event.cwd) seen.push(event.cwd);
        },
      });
      const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
      assert.equal(norm(result.cwd), norm(pr.worktreePath));
      assert.ok(seen.some((p) => norm(p) === norm(pr.worktreePath!)));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
