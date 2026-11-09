import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
  checkGitIdentity,
  formatGitIdentityFixCommands,
  formatGitIdentityPreflightMessage,
  readGitConfigValue,
} from "./git-identity.js";
import type { GhResult } from "./github.js";

const execFileAsync = promisify(execFile);

function globalConfigPath(repo: string): string {
  return path.join(repo, ".empty-global-gitconfig");
}

function isolatedGitEnv(repo: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfigPath(repo),
  };
}

function isolatedGit(repo: string) {
  return async (cwd: string, args: string[]): Promise<GhResult> => {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        env: isolatedGitEnv(repo),
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  };
}

async function initBareRepo(dir: string): Promise<void> {
  await writeFile(globalConfigPath(dir), "", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir, env: isolatedGitEnv(dir) });
}

describe("git identity", () => {
  it("formatGitIdentityFixCommands uses git -C (no shell)", () => {
    const cmd = formatGitIdentityFixCommands("C:\\repo");
    assert.match(cmd, /git -C/);
    assert.doesNotMatch(cmd, /\|\|/);
    assert.match(cmd, /user\.name/);
    assert.match(cmd, /user\.email/);
  });

  it("detects missing user.name and user.email", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-git-id-"));
    try {
      await initBareRepo(repo);
      const result = await checkGitIdentity(repo, isolatedGit(repo));
      assert.equal(result.ok, false);
      assert.deepEqual(result.missing.sort(), ["email", "name"]);
      assert.match(formatGitIdentityPreflightMessage(repo, result.missing), /git -C/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("passes when identity is set in the repo", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-git-id-ok-"));
    try {
      await initBareRepo(repo);
      await execFileAsync("git", ["config", "user.email", "a@b.com"], {
        cwd: repo,
        env: isolatedGitEnv(repo),
      });
      await execFileAsync("git", ["config", "user.name", "A"], {
        cwd: repo,
        env: isolatedGitEnv(repo),
      });
      const result = await checkGitIdentity(repo, isolatedGit(repo));
      assert.equal(result.ok, true);
      assert.equal(result.missing.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("passes when identity comes only from global config", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-git-id-global-"));
    try {
      await initBareRepo(repo);
      await writeFile(
        globalConfigPath(repo),
        "[user]\n\tname = Global User\n\temail = global@example.com\n",
        "utf8",
      );
      const result = await checkGitIdentity(repo, isolatedGit(repo));
      assert.equal(result.ok, true);
      assert.equal(result.name, "Global User");
      assert.equal(result.email, "global@example.com");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("readGitConfigValue treats a non-zero exit as unset", async () => {
    const value = await readGitConfigValue("/repo", "user.email", async () => ({
      code: 1,
      stdout: "stale@example.com\n",
      stderr: "",
    }));
    assert.equal(value, null);
  });
});
