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
} from "./git-identity.js";
import { git } from "./github.js";

const execFileAsync = promisify(execFile);

function isolatedGitEnv(repo: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(repo, ".empty-global-gitconfig"),
  };
}

async function initBareRepo(dir: string): Promise<void> {
  await writeFile(path.join(dir, ".empty-global-gitconfig"), "", "utf8");
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
      const result = await checkGitIdentity(repo, git);
      assert.equal(result.ok, false);
      assert.deepEqual(result.missing.sort(), ["email", "name"]);
      assert.match(
        formatGitIdentityPreflightMessage(repo, result.missing),
        /git -C/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("passes when identity is set", async () => {
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
      const result = await checkGitIdentity(repo, git);
      assert.equal(result.ok, true);
      assert.equal(result.missing.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
