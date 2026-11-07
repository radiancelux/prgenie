import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MERGED_HIDE_AFTER_MS, shouldHideMergedJob } from "./ci.js";
import { syncJobMergedStatus } from "./job-merge.js";
import type { RunnerConfig } from "./config.js";
import { createJob, listJobsForDisplay, loadJob } from "./store.js";

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

describe("syncJobMergedStatus", () => {
  it("sets ciStatus merged and keeps job on dashboard until hide window", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-merge-"));
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true, config: testConfig(dataDir) },
    );
    job.prNumber = 99;
    job.prUrl = "https://github.com/o/r/pull/99";

    const mergedAt = "2026-11-05T12:00:00.000Z";
    const { updated, job: after } = await syncJobMergedStatus(dataDir, job, async () => ({
      merged: true,
      mergedAt,
    }));
    assert.equal(updated, true);
    assert.equal(after.ciStatus?.status, "merged");
    assert.equal(after.ciStatus?.mergedAt, mergedAt);

    const onDisk = await loadJob(dataDir, job.id);
    assert.equal(onDisk?.ciStatus?.status, "merged");

    const mergedMs = Date.parse(mergedAt);
    assert.equal((await listJobsForDisplay(dataDir, mergedMs + 1000)).length, 1);
    assert.equal(shouldHideMergedJob(onDisk!, mergedMs + MERGED_HIDE_AFTER_MS), true);
    assert.equal((await listJobsForDisplay(dataDir, mergedMs + MERGED_HIDE_AFTER_MS)).length, 0);
    assert.equal(
      (
        await listJobsForDisplay(dataDir, mergedMs + MERGED_HIDE_AFTER_MS, {
          includeFinished: true,
        })
      ).length,
      1,
    );
  });
});
