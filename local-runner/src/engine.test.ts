import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { JobControl } from "./job-control.js";
import { createJob, loadJob, saveJob } from "./store.js";

function testConfig(dataDir: string): RunnerConfig {
  return {
    port: 9473,
    token: "test-token",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
  };
}

describe("RunnerEngine steer/stop", () => {
  it("steer reaches live JobControl without clobbering the in-flight record", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-"));
    const config = testConfig(dataDir);
    const engine = new RunnerEngine(config);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "composer-2.5", dryRun: true },
    );
    const control = JobControl.fromPersisted(job);
    engine.jobControls.set(job.id, control);

    await engine.steer(job.id, "focus on tests");
    assert.equal(control.drainSteer(), "focus on tests");
  });

  it("steer queued mid-stage survives stage save and restart", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-"));
    const config = testConfig(dataDir);
    const engine = new RunnerEngine(config);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "composer-2.5", dryRun: true },
    );
    const control = JobControl.fromPersisted(job);
    engine.jobControls.set(job.id, control);

    const inMemoryJob = { ...(await loadJob(dataDir, job.id))! };
    inMemoryJob.steerQueue = [];

    await engine.steer(job.id, "mid-stage hint");
    inMemoryJob.stage = "reviewing";
    JobControl.syncSteerQueueForPersist(inMemoryJob, control);
    await saveJob(dataDir, inMemoryJob);

    const reloaded = await loadJob(dataDir, job.id);
    assert.deepEqual(reloaded?.steerQueue, ["mid-stage hint"]);

    const restartedControl = JobControl.fromPersisted(reloaded!);
    assert.equal(restartedControl.drainSteer(), "mid-stage hint");
  });

  it("stop requests abort on live JobControl", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-"));
    const config = testConfig(dataDir);
    const engine = new RunnerEngine(config);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "composer-2.5", dryRun: true },
    );
    const control = new JobControl();
    engine.jobControls.set(job.id, control);
    let killed = false;
    control.registerKill(() => {
      killed = true;
    });

    const updated = await engine.stop(job.id);
    assert.ok(updated?.stopRequested);
    assert.equal(control.stopRequested, true);
    assert.equal(killed, true);
  });
});
