import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { CONTINUE_TERMINAL_STAGES, ContinueJobError, prepareJobContinue } from "./job-continue.js";
import { loadJob, saveJob } from "./store.js";
import type { JobRecord, JobStage } from "./types.js";
import { jobLogFile } from "./paths.js";

function cfg(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

async function seedTerminal(
  dataDir: string,
  id: string,
  stage: JobStage,
  overrides: Partial<JobRecord> = {},
): Promise<JobRecord> {
  await mkdir(path.join(dataDir, "logs"), { recursive: true });
  await writeFile(jobLogFile(dataDir, id), `log ${id}\n`, "utf8");
  const job: JobRecord = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: { repoPath: "/repo", branch: "feat/test", promptFile: "/p" },
    stage,
    reviewRound: 3,
    maxRounds: 3,
    model: "m",
    stageModels: { build: "m", review: "m", fix: "auto" },
    driverId: "cursor-agent",
    worktreePath: "/repo/.cursor-worktrees/o-r/" + id,
    repoSlug: "o/r",
    prUrl: "https://github.com/example/example/pull/1",
    prNumber: 1,
    prIsDraft: false,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: id,
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: stage === "approved" ? "APPROVE" : "CHANGES",
    error: stage === "failed" ? "boom" : null,
    logPath: jobLogFile(dataDir, id),
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
    ...overrides,
  };
  await saveJob(dataDir, job);
  return job;
}

describe("prepareJobContinue", () => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-continue-"));
  });

  for (const stage of [...CONTINUE_TERMINAL_STAGES] as JobStage[]) {
    it(`allows continue on terminal stage ${stage}`, async () => {
      const job = await seedTerminal(dataDir, `job-${stage}`, stage);
      const result = await prepareJobContinue(
        cfg(dataDir),
        { id: job.id, prompt: "do more", extraRounds: 1 },
        { isRunning: () => false },
      );
      assert.equal(result.job.stage, "fixing");
      assert.equal(result.job.maxRounds, 4);
      assert.equal(result.job.steerQueue[0], "do more");
      assert.equal(result.job.continueHistory?.length, 1);
      assert.equal(result.job.continueHistory?.[0].extraRounds, 1);
      assert.equal(result.job.continueHistory?.[0].newMaxRounds, 4);
    });
  }

  it("resumes an interrupted pre-PR job at the build stage on its existing worktree", async () => {
    const job = await seedTerminal(dataDir, "job-int-nopr", "interrupted", {
      prUrl: null,
      prNumber: null,
      reviewRound: 0,
      maxRounds: 2,
      dryRun: false,
      worktreePath: "/wt/job-int-nopr",
    });
    const seen: Array<string | null> = [];
    const result = await prepareJobContinue(
      cfg(dataDir),
      { id: job.id, prompt: "resume", model: "composer-2.5" },
      {
        isRunning: () => false,
        ensureWorktree: async (_repo, _id, branch, existing) => {
          seen.push(`${branch}@${existing}`);
          return { path: existing!, reused: true };
        },
      },
    );
    assert.equal(result.job.stage, "building");
    assert.equal(result.job.reviewRound, 0);
    assert.equal(result.job.maxRounds, 2, "no review rounds were spent before the PR");
    assert.equal(result.worktree, "reused");
    assert.equal(result.job.worktreePath, "/wt/job-int-nopr");
    assert.deepEqual(seen, ["feat/test@/wt/job-int-nopr"]);
    assert.equal(result.job.stageModels?.build, "composer-2.5");
    assert.equal(result.job.continueHistory?.[0].resumedStage, "building");
    assert.equal(result.job.continueHistory?.[0].extraRounds, 0);
    assert.equal((await loadJob(dataDir, job.id))?.stage, "building");
  });

  it("honours explicit extraRounds on a pre-PR build resume", async () => {
    const job = await seedTerminal(dataDir, "job-int-nopr2", "interrupted", {
      prUrl: null,
      prNumber: null,
      maxRounds: 2,
    });
    const result = await prepareJobContinue(
      cfg(dataDir),
      { id: job.id, extraRounds: 2 },
      { isRunning: () => false },
    );
    assert.equal(result.job.maxRounds, 4);
  });

  for (const stage of ["failed", "stopped", "stuck"] as const) {
    it(`resumes a pre-PR ${stage} job at the build stage`, async () => {
      const job = await seedTerminal(dataDir, `job-${stage}-nopr`, stage, {
        prUrl: null,
        prNumber: null,
        reviewRound: 0,
        maxRounds: 2,
        dryRun: false,
        worktreePath: `/wt/${stage}-nopr`,
      });
      const result = await prepareJobContinue(
        cfg(dataDir),
        { id: job.id, prompt: "try again" },
        {
          isRunning: () => false,
          ensureWorktree: async (_repo, _id, branch, existing) => {
            return { path: existing ?? `/wt/${stage}-nopr`, reused: true };
          },
        },
      );
      assert.equal(result.job.stage, "building");
      assert.equal(result.job.reviewRound, 0);
      assert.equal(result.job.maxRounds, 2);
      assert.equal(result.job.continueHistory?.[0].resumedStage, "building");
      assert.equal(result.job.steerQueue[0], "try again");
      assert.equal(result.worktree, "reused");
      assert.equal(result.job.worktreePath, `/wt/${stage}-nopr`);
    });
  }

  it("rejects running jobs", async () => {
    const job = await seedTerminal(dataDir, "job-run", "approved");
    await assert.rejects(
      () =>
        prepareJobContinue(
          cfg(dataDir),
          { id: job.id },
          {
            isRunning: (id) => id === job.id,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ContinueJobError);
        assert.equal((err as ContinueJobError).code, "running");
        return true;
      },
    );
  });

  it("rejects archived jobs", async () => {
    const job = await seedTerminal(dataDir, "job-arch", "approved", {
      archivedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => prepareJobContinue(cfg(dataDir), { id: job.id }, { isRunning: () => false }),
      /archived/i,
    );
  });

  it("rejects active non-terminal stages", async () => {
    const job = await seedTerminal(dataDir, "job-b", "building");
    await assert.rejects(
      () => prepareJobContinue(cfg(dataDir), { id: job.id }, { isRunning: () => false }),
      /not in a terminal stage/i,
    );
  });

  it("rejects when another job holds the branch", async () => {
    await seedTerminal(dataDir, "job-a", "approved", {
      input: { repoPath: "/repo", branch: "feat/x", promptFile: "/p" },
    });
    const other = await seedTerminal(dataDir, "job-b", "building", {
      input: { repoPath: "/repo", branch: "feat/x", promptFile: "/p" },
    });
    await assert.rejects(
      () => prepareJobContinue(cfg(dataDir), { id: "job-a" }, { isRunning: () => false }),
      /another active job/i,
    );
    assert.equal(other.stage, "building");
  });

  it("reuses worktree when ensureWorktree reports reused", async () => {
    const job = await seedTerminal(dataDir, "job-wt", "approved", { dryRun: false });
    const result = await prepareJobContinue(
      cfg(dataDir),
      { id: job.id },
      {
        isRunning: () => false,
        ensureWorktree: async () => ({ path: job.worktreePath!, reused: true }),
      },
    );
    assert.equal(result.worktree, "reused");
    assert.equal(result.job.worktreePath, job.worktreePath);
  });

  it("recreates worktree when ensureWorktree reports recreated", async () => {
    const job = await seedTerminal(dataDir, "job-wt2", "approved", {
      worktreePath: null,
      dryRun: false,
    });
    const result = await prepareJobContinue(
      cfg(dataDir),
      { id: job.id },
      {
        isRunning: () => false,
        ensureWorktree: async () => ({
          path: "/repo/.cursor-worktrees/o-r/job-wt2",
          reused: false,
        }),
      },
    );
    assert.equal(result.worktree, "recreated");
  });

  it("persists continue history and maxRounds on disk", async () => {
    const job = await seedTerminal(dataDir, "job-hist", "changes_remaining");
    await prepareJobContinue(
      cfg(dataDir),
      { id: job.id, prompt: "round 4", extraRounds: 2, model: "composer-2.5" },
      { isRunning: () => false },
    );
    const loaded = await loadJob(dataDir, job.id);
    assert.equal(loaded?.maxRounds, 5);
    assert.equal(loaded?.continueHistory?.length, 1);
    assert.equal(loaded?.continueHistory?.[0].prompt, "round 4");
    assert.equal(loaded?.stageModels?.fix, "composer-2.5");
  });
});
