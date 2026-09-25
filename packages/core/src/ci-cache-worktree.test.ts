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

async function initCliCoreRepo(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "prgenie-ci-cache-cli-core-"));
  await execAsync("git init", { cwd: tmp });
  await execAsync('git config user.email "test@test.com"', { cwd: tmp });
  await execAsync('git config user.name "Test"', { cwd: tmp });

  await mkdir(join(tmp, "packages", "core", "src"), { recursive: true });
  await mkdir(join(tmp, "packages", "cli", "src"), { recursive: true });
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({ name: "test-repo", scripts: { lint: "exit 0" } }),
  );
  await writeFile(
    join(tmp, "packages", "core", "package.json"),
    JSON.stringify({
      name: "@prgenie/core",
      type: "module",
      exports: { ".": "./src/index.ts" },
    }),
  );
  await writeFile(join(tmp, "packages", "core", "tsconfig.json"), "{}\n");
  await writeFile(join(tmp, "packages", "core", "src", "index.ts"), "export const core = 1;\n");
  await writeFile(
    join(tmp, "packages", "cli", "package.json"),
    JSON.stringify({
      name: "@prgenie/cli",
      type: "module",
      dependencies: { "@prgenie/core": "workspace:*" },
    }),
  );
  await writeFile(
    join(tmp, "packages", "cli", "tsconfig.json"),
    '{ "extends": "../../tsconfig.base.json" }\n',
  );
  await writeFile(
    join(tmp, "packages", "cli", "src", "cli.ts"),
    'import { core } from "@prgenie/core";\nexport const cli = core;\n',
  );
  await writeFile(join(tmp, "README.md"), "# readme\n");

  await execAsync("git add .", { cwd: tmp });
  await execAsync('git commit -m "Initial commit"', { cwd: tmp });
  return tmp;
}

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

  it("computeCheckInputHash changes when scoped format paths are dirty in index", async () => {
    const repo = await initPackageRepo();
    try {
      const scope: CheckInputScopeOptions = {
        changedPaths: ["README.md"],
        formatScoped: true,
      };

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

  it("typecheck:cli misses cache when packages/core is dirty but README stays a hit", async () => {
    const repo = await initCliCoreRepo();
    try {
      await clearCiCache(repo);
      const scope: CheckInputScopeOptions = { changedPaths: ["packages/cli/src/cli.ts"] };

      await recordCheckPass(repo, "typecheck:cli", scope);
      assert.ok(await getCachedResult(repo, "typecheck:cli", scope));

      await writeFile(join(repo, "README.md"), "# unrelated dirty\n");
      assert.ok(
        await getCachedResult(repo, "typecheck:cli", scope),
        "unrelated dirty file outside workspace deps should stay cached",
      );

      await writeFile(
        join(repo, "packages", "core", "src", "index.ts"),
        "export const core = 99;\n",
      );
      assert.equal(
        await getCachedResult(repo, "typecheck:cli", scope),
        null,
        "dirty packages/core should invalidate typecheck:cli (workspace dep)",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("format:check misses cache on unstaged .prettierrc.json edit", async () => {
    const repo = await initPackageRepo();
    try {
      await writeFile(join(repo, ".prettierrc.json"), '{"singleQuote": true}\n');
      await execAsync("git add .prettierrc.json", { cwd: repo });
      await execAsync('git commit -m "Add prettier config"', { cwd: repo });

      await clearCiCache(repo);
      const scope: CheckInputScopeOptions = {
        changedPaths: ["README.md"],
        formatScoped: true,
      };

      await recordCheckPass(repo, "format:check", scope);
      assert.ok(await getCachedResult(repo, "format:check", scope));

      await writeFile(join(repo, ".prettierrc.json"), '{"singleQuote": false}\n');

      assert.equal(
        await getCachedResult(repo, "format:check", scope),
        null,
        "unstaged prettier config edit should invalidate format:check",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("format:check misses cache on unstaged .prettierignore edit", async () => {
    const repo = await initPackageRepo();
    try {
      await writeFile(join(repo, ".prettierignore"), "README.md\n");
      await execAsync("git add .prettierignore", { cwd: repo });
      await execAsync('git commit -m "Add prettierignore"', { cwd: repo });

      await clearCiCache(repo);
      const scope: CheckInputScopeOptions = {
        changedPaths: ["README.md"],
        formatScoped: true,
      };

      await recordCheckPass(repo, "format:check", scope);
      assert.ok(await getCachedResult(repo, "format:check", scope));

      await writeFile(join(repo, ".prettierignore"), "README.md\npackages/**\n");

      assert.equal(
        await getCachedResult(repo, "format:check", scope),
        null,
        "unstaged prettierignore edit should invalidate format:check",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
