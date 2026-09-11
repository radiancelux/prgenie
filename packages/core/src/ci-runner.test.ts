import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runCiChecks } from "./ci-runner.js";

const execAsync = promisify(exec);

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

describe("runCiChecks", () => {
  it("returns all passed when all checks succeed", async () => {
    const repo = await initTestRepo();
    try {
      const result = await runCiChecks(repo, { timeout: 5000 });

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
      await rm(repo, { recursive: true, force: true });
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

      const result = await runCiChecks(repo, { timeout: 5000 });

      assert.equal(result.allPassed, false);
      const lintCheck = result.checks.find((c) => c.name === "lint");
      assert.ok(lintCheck);
      assert.equal(lintCheck.passed, false);
      assert.ok(lintCheck.error);

      // Other checks should still pass
      const passedChecks = result.checks.filter((c) => c.name !== "lint");
      assert.ok(passedChecks.every((c) => c.passed));
    } finally {
      await rm(repo, { recursive: true, force: true });
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

      const result = await runCiChecks(repo, { timeout: 5000 });

      assert.equal(result.allPassed, false);

      const failedChecks = result.checks.filter((c) => !c.passed);
      assert.equal(failedChecks.length, 3);

      const failedNames = failedChecks.map((c) => c.name);
      assert.ok(failedNames.includes("format:check"));
      assert.ok(failedNames.includes("typecheck"));
      assert.ok(failedNames.includes("build"));
    } finally {
      await rm(repo, { recursive: true, force: true });
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
      await rm(repo, { recursive: true, force: true });
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
      await rm(repo, { recursive: true, force: true });
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
      await execAsync(
        `ln -s ${join(process.cwd(), "node_modules")} ${join(repo, "node_modules")}`,
        {
          cwd: repo,
        },
      );

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
      await rm(repo, { recursive: true, force: true });
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
      await execAsync(
        `ln -s ${join(process.cwd(), "node_modules")} ${join(repo, "node_modules")}`,
        {
          cwd: repo,
        },
      );

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
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
