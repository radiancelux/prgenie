import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveJobSpawnCwd } from "./job-cwd.js";

describe("resolveJobSpawnCwd", () => {
  it("falls back to repoPath when worktreePath is missing on disk", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-repo-"));
    const cwd = resolveJobSpawnCwd({
      worktreePath: path.join(repo, "gone-worktree"),
      input: { repoPath: repo, branch: "b", promptFile: "/p" },
    });
    assert.equal(cwd, repo);
  });

  it("prefers an existing worktreePath", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-repo-"));
    const cwd = resolveJobSpawnCwd({
      worktreePath: repo,
      input: { repoPath: "/other", branch: "b", promptFile: "/p" },
    });
    assert.equal(cwd, repo);
  });
});
