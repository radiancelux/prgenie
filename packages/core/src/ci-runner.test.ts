import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCiChecks } from "./ci-runner.js";

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
});
