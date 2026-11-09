import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { GhResult } from "./github.js";
import {
  assertSafeToResetBranchAtBase,
  ensureContinueWorktree,
  ensureWorktree,
  parseWorktreePathForBranch,
} from "./worktree.js";
import { cursorWorktreeDir } from "./paths.js";

function ok(stdout = "", stderr = ""): GhResult {
  return { code: 0, stdout, stderr };
}

function fail(stderr: string): GhResult {
  return { code: 1, stdout: "", stderr };
}

describe("ensureWorktree", () => {
  const repoPath = "/repo/proj";
  const jobId = "job-abc";
  const branch = "feat/new";
  const baseSha = "a".repeat(40);
  const wt = cursorWorktreeDir("proj", jobId);

  it("calls fetch origin before worktree add for a new branch", async () => {
    const calls: string[][] = [];
    const gitImpl = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\nbranch refs/heads/main\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(baseSha);
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") return ok();
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(result.path, wt);
    assert.equal(result.baseRef, "origin/main");
    assert.equal(result.baseSha, baseSha);
    const fetchIdx = calls.findIndex((a) => a[0] === "fetch");
    const addIdx = calls.findIndex((a) => a[0] === "worktree" && a[1] === "add");
    assert.ok(fetchIdx >= 0);
    assert.ok(addIdx >= 0);
    assert.ok(fetchIdx < addIdx, "fetch must run before worktree add");
  });

  it("treats fetch failure as non-fatal and still adds the worktree", async () => {
    let addCalled = false;
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return fail("network down");
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(baseSha);
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") {
        addCalled = true;
        return ok();
      }
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(addCalled, true);
    assert.equal(result.baseSha, baseSha);
  });

  it("records resolved base ref and SHA on success", async () => {
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[2] === "origin/main") return ok(baseSha);
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return ok(baseSha);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return fail("bad ref");
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") return ok();
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(result.baseRef, "origin/main");
    assert.equal(result.baseSha, baseSha);
  });

  it("refuses -B when the local branch has commits beyond the base", async () => {
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(baseSha);
      if (args[0] === "show-ref") return ok();
      if (args[0] === "rev-list" && args[1] === "--count") return ok("2\n");
      return ok();
    };

    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl }),
      /refusing to reset local branch "feat\/new".*fresh branch name/i,
    );
  });
});

describe("assertSafeToResetBranchAtBase", () => {
  it("allows a new branch name", async () => {
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "show-ref") return fail("");
      return ok();
    };
    await assertSafeToResetBranchAtBase("/r", "feat/x", "origin/main", gitImpl);
  });
});

describe("ensureContinueWorktree", () => {
  const repoPath = "/repo/proj";
  const jobId = "job-stuck";
  const branch = "feat/resume";
  const existingWt = cursorWorktreeDir("proj", jobId);

  it("reuses the job's own worktree when the branch is still checked out there", async () => {
    const existingWt = path.join(os.tmpdir(), `lr-wt-${jobId}`);
    await mkdir(existingWt, { recursive: true });
    await access(existingWt);
    const porcelain = `worktree ${existingWt}\nHEAD ${"b".repeat(40)}\nbranch refs/heads/${branch}\n`;
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ok(porcelain);
      return ok();
    };

    const result = await ensureContinueWorktree(
      repoPath,
      jobId,
      branch,
      existingWt,
      undefined,
      { gitImpl },
    );
    assert.equal(result.reused, true);
    assert.equal(result.path, existingWt);
  });

  it("names another worktree when a different job holds the branch", async () => {
    const otherWt = path.join(os.tmpdir(), "other-job-wt");
    const porcelain = `worktree ${otherWt}\nbranch refs/heads/${branch}\n`;
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ok(porcelain);
      return ok();
    };

    await assert.rejects(
      () =>
        ensureContinueWorktree(repoPath, jobId, branch, existingWt, undefined, {
          gitImpl,
        }),
      new RegExp(`already checked out at ${otherWt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    await assert.rejects(
      () =>
        ensureContinueWorktree(repoPath, jobId, branch, existingWt, undefined, {
          gitImpl,
        }),
      /git worktree remove/,
    );
  });
});

describe("parseWorktreePathForBranch", () => {
  it("finds the checkout path for a branch", () => {
    const p = parseWorktreePathForBranch(
      "worktree /a/wt\nbranch refs/heads/feat/foo\n\nworktree /b/wt\nbranch refs/heads/main\n",
      "feat/foo",
    );
    assert.equal(p, "/a/wt");
  });
});
