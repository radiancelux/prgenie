import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  clearCiCache,
  computeCheckInputHash,
  getCachedResult,
  recordCheckPass,
  type CheckInputScopeOptions,
} from "./ci-cache.js";

const execAsync = promisify(exec);

async function initPackageRepo(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-wt-"));
  await execAsync("git init", { cwd: tmp });
  await execAsync('git config user.email "test@test.com"', { cwd: tmp });
  await execAsync('git config user.name "Test"', { cwd: tmp });

  await mkdir(join(tmp, "packages", "core", "src"), { recursive: true });
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: { lint: "exit 0" },
    }),
  );
  await writeFile(
    join(tmp, "packages", "core", "package.json"),
    JSON.stringify({ name: "@test/core", type: "module" }),
  );
  await writeFile(join(tmp, "packages", "core", "tsconfig.json"), "{}\n");
  await writeFile(join(tmp, "packages", "core", "src", "alpha.ts"), "export const a = 1;\n");
  await writeFile(join(tmp, "packages", "core", "src", "beta.ts"), "export const b = 2;\n");
  await writeFile(join(tmp, "README.md"), "# readme\n");
  await execAsync("git add .", { cwd: tmp });
  await execAsync('git commit -m "Initial commit"', { cwd: tmp });
  return tmp;
}

function coreLintScope(): CheckInputScopeOptions {
  return { changedPaths: ["packages/core/src/alpha.ts"] };
}

describe("RAD-118 worktree CI cache", () => {
  it("cache hit after unrelated dirty edit outside check scope", async () => {
    const repo = await initPackageRepo();
    try {
      await clearCiCache(repo);
      const scope = coreLintScope();

      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await writeFile(join(repo, "README.md"), "# dirty unrelated\n");

      assert.ok(
        await getCachedResult(repo, "lint:core", scope),
        "unrelated dirty edit should not invalidate lint:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("cache miss when a file in check scope is dirty", async () => {
    const repo = await initPackageRepo();
    try {
      await clearCiCache(repo);
      const scope = coreLintScope();

      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await writeFile(join(repo, "packages", "core", "src", "alpha.ts"), "export const a = 99;\n");

      assert.equal(
        await getCachedResult(repo, "lint:core", scope),
        null,
        "dirty file in packages/core should invalidate lint:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("computeCheckInputHash changes when scoped format paths are dirty", async () => {
    const repo = await initPackageRepo();
    try {
      const scope = {
        changedPaths: ["README.md"],
        formatScoped: true,
      } as const;

      const before = await computeCheckInputHash(repo, "format:check", scope);
      assert.ok(before);

      await writeFile(join(repo, "README.md"), "# changed\n");
      await execAsync("git add README.md", { cwd: repo });
      const after = await computeCheckInputHash(repo, "format:check", scope);

      assert.notEqual(before, after, "dirty scoped format path should change hash");
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

});
