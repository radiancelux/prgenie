import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COMPUTE_JOB_DEFAULT_WATCHDOG,
  baseWatchdogForJobType,
  resolveJobWatchdogSnapshot,
} from "./job-type-watchdog.js";
import { saveSettings } from "./settings.js";
import { createJob } from "./store.js";
import type { RunnerConfig } from "./config.js";
import { workerBudgetForJob } from "./job-worker-monitor.js";
import type { JobRecord } from "./types.js";

describe("job-type watchdog", () => {
  it("compute jobs use longer built-in watchdog defaults", () => {
    assert.equal(COMPUTE_JOB_DEFAULT_WATCHDOG.inactivityMs, 60 * 60 * 1000);
    assert.equal(COMPUTE_JOB_DEFAULT_WATCHDOG.stageCapMs, 8 * 60 * 60 * 1000);
  });

  it("settings v2 jobTypes.compute.watchdog overrides compute defaults", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-jt-wd-"));
    await saveSettings(dataDir, {
      jobTypes: {
        compute: {
          watchdog: { inactivityMs: 120_000, stageCapMs: 3_600_000, recoveryAttempts: 1 },
        },
      },
    });
    const fromSettings = await import("./settings.js").then((m) => m.loadSettings(dataDir));
    const policy = baseWatchdogForJobType("compute", fromSettings);
    assert.equal(policy.inactivityMs, 120_000);
    assert.equal(policy.stageCapMs, 3_600_000);
    assert.equal(policy.recoveryAttempts, 1);
  });

  it("start_job watchdog override lands in effectiveSnapshot", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-jt-snap-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-jt-repo-"));
    const config: RunnerConfig = {
      host: "127.0.0.1",
      port: 9474,
      token: "t",
      dataDir,
      notifyEmail: null,
      resendApiKey: null,
      defaultModel: "composer-2.5",
      dryRun: true,
      defaultCodeRepoPath: null,
    };
    const job = await createJob(
      dataDir,
      {
        repoPath: repo,
        branch: "feat/compute",
        promptFile: path.join(repo, "p.md"),
        jobType: "compute",
        watchdog: { inactivityMs: 90_000 },
      },
      { model: "composer-2.5", dryRun: true, config },
    );
    assert.equal(job.input.jobType, "compute");
    assert.equal(job.effectiveSnapshot?.watchdogInactivityMs, 90_000);
    assert.ok(
      (job.effectiveSnapshot?.watchdogStageCapMs ?? 0) >= COMPUTE_JOB_DEFAULT_WATCHDOG.stageCapMs,
    );
  });

  it("raises detached worker stage budget from a compute snapshot", () => {
    const compute: JobRecord = {
      effectiveSnapshot: {
        maxRounds: 2,
        stageModels: { build: "m", review: "m", fix: "m" },
        baseRef: "main",
        watchdogInactivityMs: COMPUTE_JOB_DEFAULT_WATCHDOG.inactivityMs,
        watchdogStageCapMs: COMPUTE_JOB_DEFAULT_WATCHDOG.stageCapMs,
        watchdogRecoveryAttempts: 0,
      },
    } as JobRecord;
    const code: JobRecord = {
      effectiveSnapshot: {
        maxRounds: 2,
        stageModels: { build: "m", review: "m", fix: "m" },
        baseRef: "main",
        watchdogInactivityMs: 15 * 60_000,
        watchdogStageCapMs: 120 * 60_000,
        watchdogRecoveryAttempts: 1,
      },
    } as JobRecord;
    assert.ok(workerBudgetForJob(compute).stageBudgetMs > workerBudgetForJob(code).stageBudgetMs);
    assert.ok(
      workerBudgetForJob(compute).heartbeatStaleMs > workerBudgetForJob(code).heartbeatStaleMs,
    );
  });

  it("resolveJobWatchdogSnapshot merges profile, settings bag, and request", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-jt-merge-"));
    await saveSettings(dataDir, {
      watchdog: { inactivityMs: 900_000, stageCapMs: 7_200_000, recoveryAttempts: 1 },
      jobTypes: { compute: { watchdog: { stageCapMs: 5_400_000 } } },
    });
    const settings = await import("./settings.js").then((m) => m.loadSettings(dataDir));
    const snap = resolveJobWatchdogSnapshot("compute", settings, { inactivityMs: 180_000 });
    assert.equal(snap.inactivityMs, 180_000);
    assert.equal(snap.stageCapMs, 5_400_000);
    assert.equal(snap.recoveryAttempts, 0);
  });
});
