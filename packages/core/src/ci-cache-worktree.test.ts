import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from "node:fs/promises";
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

async function initFileScopedRepo(): Promise<string> {
  const repo = await initPackageRepo();
  await writeFile(
    join(repo, "packages", "core", "src", "alpha.test.ts"),
    'import { b } from "./beta.js";\nexport const t = b;\n',
  );
  await execAsync("git add packages/core/src/alpha.test.ts", { cwd: repo });
  await execAsync('git commit -m "Add alpha test"', { cwd: repo });
  return repo;
}

function fileScopedCore(): CheckInputScopeOptions {
  const testFiles = ["packages/core/src/alpha.test.ts"];
  return { changedPaths: [...testFiles], testFiles };
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

  it("lint:core misses when pnpm-lock.yaml changes", async () => {
    const repo = await initPackageRepo();
    try {
      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\n");

      assert.equal(
        await getCachedResult(repo, "lint:core", scope),
        null,
        "pnpm-lock.yaml edit should invalidate lint:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("typecheck:core misses when a root package.json devDependency changes", async () => {
    const repo = await initPackageRepo();
    try {
      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "typecheck:core", scope);
      assert.ok(await getCachedResult(repo, "typecheck:core", scope));

      const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      pkg.devDependencies = { typescript: "9.9.9" };
      await writeFile(join(repo, "package.json"), JSON.stringify(pkg));

      assert.equal(
        await getCachedResult(repo, "typecheck:core", scope),
        null,
        "root devDependency bump should invalidate typecheck:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("test:core misses when tsconfig.base.json changes", async () => {
    const repo = await initPackageRepo();
    try {
      await writeFile(
        join(repo, "tsconfig.base.json"),
        '{ "compilerOptions": { "strict": true } }\n',
      );
      await execAsync("git add tsconfig.base.json", { cwd: repo });
      await execAsync('git commit -m "Add tsconfig base"', { cwd: repo });

      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "test:core", scope);
      assert.ok(await getCachedResult(repo, "test:core", scope));

      await writeFile(
        join(repo, "tsconfig.base.json"),
        '{ "compilerOptions": { "strict": false } }\n',
      );

      assert.equal(
        await getCachedResult(repo, "test:core", scope),
        null,
        "tsconfig.base.json edit should invalidate test:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("lint:core misses when a new gitignored file appears in the package", async () => {
    const repo = await initPackageRepo();
    try {
      await writeFile(join(repo, ".gitignore"), "*.local.ts\n");
      await execAsync("git add .gitignore", { cwd: repo });
      await execAsync('git commit -m "Ignore local ts"', { cwd: repo });

      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await writeFile(
        join(repo, "packages", "core", "src", "scratch.local.ts"),
        "export const secret = 1;\n",
      );

      assert.equal(
        await getCachedResult(repo, "lint:core", scope),
        null,
        "new gitignored file in the check directory should invalidate lint:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("lint:core still hits when only a gitignored node_modules file appears", async () => {
    const repo = await initPackageRepo();
    try {
      await writeFile(join(repo, ".gitignore"), "node_modules/\n");
      await execAsync("git add .gitignore", { cwd: repo });
      await execAsync('git commit -m "Ignore node_modules"', { cwd: repo });

      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await mkdir(join(repo, "packages", "core", "node_modules", "pkg"), { recursive: true });
      await writeFile(
        join(repo, "packages", "core", "node_modules", "pkg", "index.js"),
        "module.exports = 1;\n",
      );

      assert.ok(
        await getCachedResult(repo, "lint:core", scope),
        "node_modules is omitted; lockfile and root package.json cover install identity",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("untracked node_modules junction without .gitignore is omitted (no hang / still hits)", async () => {
    const repo = await initPackageRepo();
    const installTree = await mkdtemp(join(tmpdir(), "prgenie-nm-junction-"));
    try {
      // No .gitignore — listing must not walk the junction (exclude pathspec + --directory).
      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      // Populate a fake primary install tree, then junction/symlink it in-scope.
      for (let i = 0; i < 80; i++) {
        const pkg = join(installTree, `pkg-${i}`);
        await mkdir(pkg, { recursive: true });
        await writeFile(join(pkg, "index.js"), `module.exports = ${i};\n`);
      }
      const link = join(repo, "packages", "core", "node_modules");
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(installTree, link, type);

      const started = Date.now();
      const hash = await computeCheckInputHash(repo, "lint:core", scope);
      const elapsedMs = Date.now() - started;
      assert.ok(hash, "omitted untracked install junction must not fail-closed the whole hash");
      assert.ok(elapsedMs < 30_000, `junction listing must not hang (took ${elapsedMs}ms)`);
      assert.ok(
        await getCachedResult(repo, "lint:core", scope),
        "untracked node_modules junction without .gitignore stays a hit",
      );

      // Other untracked files in scope still affect the hash.
      await writeFile(join(repo, "packages", "core", "src", "extra.ts"), "export const x = 1;\n");
      assert.equal(
        await getCachedResult(repo, "lint:core", scope),
        null,
        "non-omitted untracked files in scope still miss",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
      await rm(installTree, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("untracked non-omitted directory without .gitignore misses lint:core", async () => {
    const repo = await initPackageRepo();
    try {
      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await mkdir(join(repo, "packages", "core", "vendor", "nested"), { recursive: true });
      await writeFile(
        join(repo, "packages", "core", "vendor", "nested", "mod.ts"),
        "export const v = 1;\n",
      );

      assert.equal(
        await computeCheckInputHash(repo, "lint:core", scope),
        null,
        "non-omitted untracked directory is a miss (no junction descent)",
      );
      assert.equal(await getCachedResult(repo, "lint:core", scope), null);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("lint:core misses when an unknown gitignored directory appears in the package", async () => {
    const repo = await initPackageRepo();
    try {
      await writeFile(join(repo, ".gitignore"), "packages/core/scratch/\n");
      await execAsync("git add .gitignore", { cwd: repo });
      await execAsync('git commit -m "Ignore scratch"', { cwd: repo });

      await clearCiCache(repo);
      const scope = coreLintScope();
      await recordCheckPass(repo, "lint:core", scope);
      assert.ok(await getCachedResult(repo, "lint:core", scope));

      await mkdir(join(repo, "packages", "core", "scratch"), { recursive: true });
      await writeFile(
        join(repo, "packages", "core", "scratch", "hidden.ts"),
        "export const h = 1;\n",
      );

      assert.equal(
        await getCachedResult(repo, "lint:core", scope),
        null,
        "unknown gitignored directory in scope should fail closed",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("file-scoped test:core misses when the base moves and an imported module changes", async () => {
    const repo = await initFileScopedRepo();
    try {
      await clearCiCache(repo);
      const scope = fileScopedCore();
      await recordCheckPass(repo, "test:core", scope);
      assert.ok(await getCachedResult(repo, "test:core", scope));

      await writeFile(join(repo, "packages", "core", "src", "beta.ts"), "export const b = 9;\n");
      await execAsync("git add packages/core/src/beta.ts", { cwd: repo });
      await execAsync('git commit -m "Base moves imported module"', { cwd: repo });

      assert.equal(
        await getCachedResult(repo, "test:core", fileScopedCore()),
        null,
        "moved base that changes an imported module should invalidate file-scoped test:core",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("file-scoped test:core misses when scope is unchanged but an imported module is dirty", async () => {
    const repo = await initFileScopedRepo();
    try {
      await clearCiCache(repo);
      const scope = fileScopedCore();
      await recordCheckPass(repo, "test:core", scope);
      assert.ok(await getCachedResult(repo, "test:core", scope));

      await writeFile(join(repo, "README.md"), "# dirty unrelated\n");
      assert.ok(
        await getCachedResult(repo, "test:core", scope),
        "dirty README outside the package tree should stay cached",
      );

      await writeFile(join(repo, "packages", "core", "src", "beta.ts"), "export const b = 9;\n");

      assert.equal(
        await getCachedResult(repo, "test:core", scope),
        null,
        "unchanged file scope should still miss when an imported module is dirty",
      );
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("content behind a tracked directory symlink misses lint:core", async () => {
    const repo = await initPackageRepo();
    try {
      const scope = coreLintScope();
      assert.ok(
        await computeCheckInputHash(repo, "lint:core", scope),
        "regular files in scope should hash",
      );

      await mkdir(join(repo, "vendor"));
      await writeFile(join(repo, "vendor", "mod.ts"), "export const v = 1;\n");
      await execAsync("git add vendor", { cwd: repo });
      await execAsync('git commit -m "Add vendor"', { cwd: repo });

      const blobPath = join(repo, ".symlink-blob");
      await writeFile(blobPath, "vendor");
      const { stdout } = await execAsync("git hash-object -w .symlink-blob", { cwd: repo });
      await rm(blobPath, { force: true });
      const sha = stdout.trim();
      await execAsync(`git update-index --add --cacheinfo 120000,${sha},packages/core/src/linked`, {
        cwd: repo,
      });
      await execAsync('git commit -m "Add directory symlink"', { cwd: repo });

      assert.equal(
        await computeCheckInputHash(repo, "lint:core", scope),
        null,
        "tracked directory symlink in scope is a miss",
      );

      await writeFile(join(repo, "vendor", "mod.ts"), "export const v = 2;\n");
      assert.equal(
        await computeCheckInputHash(repo, "lint:core", scope),
        null,
        "content behind the directory symlink stays a miss",
      );
      assert.equal(await getCachedResult(repo, "lint:core", scope), null);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
