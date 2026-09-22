import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWorktreeCiToolchain,
  formatToolchainSetupError,
  hasCiBin,
  isCiEnvFailureOutput,
  missingCiBins,
} from "./worktree-deps.js";

async function makePrimaryWithBins(root: string): Promise<string> {
  const primary = join(root, "prgenie");
  await mkdir(join(primary, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(primary, "package.json"), JSON.stringify({ name: "prgenie" }));
  for (const bin of ["eslint", "tsc", "tsx", "prettier"]) {
    const stub = process.platform === "win32" ? `${bin}.CMD` : bin;
    await writeFile(join(primary, "node_modules", ".bin", stub), "@echo off\r\n");
  }
  return primary;
}

describe("isCiEnvFailureOutput", () => {
  it("detects missing-bin / not-recognized failures as env unhealthy", () => {
    assert.equal(
      isCiEnvFailureOutput("'eslint' is not recognized as an internal or external command."),
      true,
    );
    assert.equal(
      isCiEnvFailureOutput('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "eslint" not found'),
      true,
    );
    assert.equal(isCiEnvFailureOutput("Cannot find module 'eslint'"), true);
    assert.equal(isCiEnvFailureOutput("Missing toolchain in worktree: eslint"), true);
  });

  it("does not treat product assertion failures as env unhealthy", () => {
    assert.equal(isCiEnvFailureOutput("AssertionError: expected 1 to equal 2"), false);
    assert.equal(isCiEnvFailureOutput("✖ 3 problems (3 errors, 0 warnings)"), false);
    assert.equal(isCiEnvFailureOutput("error TS2304: Cannot find name 'foo'"), false);
  });
});

describe("ensureWorktreeCiToolchain", () => {
  it("junctions/links primary node_modules into a loop worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "prgenie-wt-deps-"));
    try {
      const primary = await makePrimaryWithBins(root);
      const worktree = join(root, "prgenie.loops", "lp-abcd1234");
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, "package.json"), JSON.stringify({ name: "loop" }));

      assert.equal(hasCiBin(worktree, "eslint"), false);

      const result = await ensureWorktreeCiToolchain(worktree, {
        primaryPath: primary,
        skipInstall: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.envUnhealthy, false);
      assert.ok(result.method === "junction" || result.method === "symlink");
      assert.ok(result.linked.includes("node_modules"));
      assert.equal(hasCiBin(worktree, "eslint"), true);
      assert.equal(missingCiBins(worktree).length, 0);
      assert.ok(existsSync(join(worktree, "node_modules")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a clear setup error with fix steps when primary has no node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "prgenie-wt-deps-miss-"));
    try {
      const primary = join(root, "prgenie");
      await mkdir(primary, { recursive: true });
      await writeFile(join(primary, "package.json"), JSON.stringify({ name: "prgenie" }));
      const worktree = join(root, "prgenie.loops", "lp-deadbeef");
      await mkdir(worktree, { recursive: true });

      const result = await ensureWorktreeCiToolchain(worktree, {
        primaryPath: primary,
        skipInstall: true,
      });

      assert.equal(result.ok, false);
      assert.equal(result.envUnhealthy, true);
      assert.match(result.message, /Missing toolchain in worktree/i);
      assert.match(result.message, /CI environment unhealthy/i);
      assert.ok(result.fixSteps.length >= 2);
      assert.match(formatToolchainSetupError(result), /Fix:/);
      assert.match(formatToolchainSetupError(result), /pnpm install/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips junction for non-loop checkouts (unit fixtures / primary)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-wt-deps-nonloop-"));
    try {
      await writeFile(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
      const result = await ensureWorktreeCiToolchain(repo, { skipInstall: true });
      assert.equal(result.ok, true);
      assert.equal(result.envUnhealthy, false);
      assert.equal(result.method, "none");
      assert.match(result.message, /Not a loop worktree/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("links package-local node_modules even when root bins already exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "prgenie-wt-deps-pkg-"));
    try {
      const primary = await makePrimaryWithBins(root);
      await mkdir(join(primary, "packages", "core"), { recursive: true });
      await writeFile(
        join(primary, "packages", "core", "package.json"),
        '{"name":"@prgenie/core"}',
      );
      await mkdir(join(primary, "packages", "cli", "node_modules", "@prgenie"), {
        recursive: true,
      });
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(
        join(primary, "packages", "core"),
        join(primary, "packages", "cli", "node_modules", "@prgenie", "core"),
        type,
      );

      const worktree = join(root, "prgenie.loops", "lp-feedface");
      await mkdir(join(worktree, "packages", "core"), { recursive: true });
      await writeFile(
        join(worktree, "packages", "core", "package.json"),
        '{"name":"@prgenie/core"}',
      );
      await writeFile(join(worktree, "packages", "core", "WORKTREE"), "1");
      await symlink(join(primary, "node_modules"), join(worktree, "node_modules"), type);
      assert.equal(hasCiBin(worktree, "eslint"), true);

      const result = await ensureWorktreeCiToolchain(worktree, {
        primaryPath: primary,
        skipInstall: true,
      });
      assert.equal(result.ok, true);
      assert.ok(
        result.linked.some((p) => p.replace(/\\/g, "/").includes("packages/cli/node_modules")),
        `expected package link in ${result.linked.join(", ")}`,
      );
      assert.ok(existsSync(join(worktree, "packages", "cli", "node_modules", "@prgenie", "core")));
      // Workspace link must point at the worktree package, not primary.
      assert.ok(
        existsSync(
          join(worktree, "packages", "cli", "node_modules", "@prgenie", "core", "WORKTREE"),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
