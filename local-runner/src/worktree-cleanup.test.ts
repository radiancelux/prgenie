import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { MERGED_HIDE_AFTER_MS } from "./ci.js";
import {
  tryRemoveJobWorktree,
  worktreeHasUncommittedChanges,
  worktreePathExists,
} from "./worktree-cleanup.js";
import type { JobRecord } from "./types.js";
import { loadJob } from "./store.js";

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "m",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/repo", branch: "feat/x", promptFile: "/p" },
    stage: "approved",
    reviewRound: 1,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    prIsDraft: false,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    tokenUsage: null,
    ciStatus: {
      status: "merged",
      mergedAt: "2026-01-01T12:00:00.000Z",
      checkedAt: "",
      source: "github",
    },
    lastVerdict: "APPROVE",
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: false,
    archivedAt: null,
    ...overrides,
  };
}

describe("worktree cleanup", () => {
  it("already-missing worktree path clears without throw", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-wt-miss-"));
    const config = testConfig(dataDir);
    const j = job({ worktreePath: "/no/such/worktree/path" });
    const gitImpl = async (cwd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "deadbeef\n", stderr: "" };
      if (args[0] === "worktree") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await tryRemoveJobWorktree(config, j, {
      reason: "merged_hidden",
      gitImpl: gitImpl as never,
    });
    assert.equal(r.removed, true);
    assert.equal(j.worktreePath, null);
  });

  it("skips dirty worktree with warning", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-wt-dirty-"));
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-wt-dir-"));
    const config = testConfig(dataDir);
    const j = job({ worktreePath: wt, input: { repoPath: wt, branch: "b", promptFile: "/p" } });
    assert.equal(await worktreePathExists(wt), true);

    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "status" && args[1] === "--porcelain") {
        return { code: 0, stdout: "?? dirty.txt\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await tryRemoveJobWorktree(config, j, {
      reason: "merged_hidden",
      gitImpl: gitImpl as never,
    });
    assert.equal(r.removed, false);
    if ("skipped" in r) assert.equal(r.skipped, "dirty");
    assert.match(j.error ?? "", /uncommitted/i);
  });

  it("skips unpushed commits", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-wt-unp-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-wt-repo-"));
    const wt = path.join(repo, "wt");
    await mkdir(wt, { recursive: true });
    const config = testConfig(dataDir);
    const j = job({
      worktreePath: wt,
      input: { repoPath: repo, branch: "feat/x", promptFile: "/p" },
    });

    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("HEAD")) return { code: 0, stdout: "aaa\n", stderr: "" };
      if (args.includes("origin/feat/x")) return { code: 0, stdout: "bbb\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const r = await tryRemoveJobWorktree(config, j, {
      reason: "merged_hidden",
      gitImpl: gitImpl as never,
    });
    assert.equal(r.removed, false);
    if ("skipped" in r) assert.equal(r.skipped, "unpushed");
  });

  it("merged hidden job removes clean synced worktree", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-wt-rm-"));
    await mkdir(path.join(dataDir, "jobs"), { recursive: true });
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-wt-repo2-"));
    const wt = path.join(repo, "wt");
    await mkdir(wt, { recursive: true });
    const config = testConfig(dataDir);
    const j = job({
      id: "job-1",
      worktreePath: wt,
      input: { repoPath: repo, branch: "feat/x", promptFile: "/p" },
      ciStatus: {
        status: "merged",
        mergedAt: new Date(Date.now() - MERGED_HIDE_AFTER_MS - 1000).toISOString(),
        checkedAt: "",
        source: "github",
      },
    });
    const { saveJob } = await import("./store.js");
    await saveJob(dataDir, j);

    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "same\n", stderr: "" };
      if (args[0] === "worktree") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const r = await tryRemoveJobWorktree(config, j, {
      reason: "merged_hidden",
      gitImpl: gitImpl as never,
    });
    assert.equal(r.removed, true);
    const onDisk = await loadJob(dataDir, "job-1");
    assert.equal(onDisk?.worktreePath, null);
  });
});
