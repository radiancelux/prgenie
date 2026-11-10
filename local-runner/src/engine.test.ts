import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { JobControl } from "./job-control.js";
import { createJob, loadJob, saveJob } from "./store.js";
import { loadSettings, saveSettings } from "./settings.js";
import { BranchConflictError } from "./job-queue.js";

const execFileAsync = promisify(execFile);

async function initBareGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@test"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);
}

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "test-token",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
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
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
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
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
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
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
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

describe("RunnerEngine queue", () => {
  const prompt = "/missing-prompt.md";

  async function seedJob(dataDir: string, repo: string, branch: string, queued = false) {
    const job = await createJob(
      dataDir,
      { repoPath: repo, branch, promptFile: prompt, maxRounds: 1, dryRun: true },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    if (queued) {
      job.queueState = { queued: true, since: new Date().toISOString() };
      await saveJob(dataDir, job);
    }
    return job;
  }

  async function waitForIdle(engine: RunnerEngine, ids: string[]): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (ids.some((id) => engine.isRunning(id))) {
      if (Date.now() > deadline) throw new Error("jobs did not settle");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("rejects a duplicate same-branch submission while the cap is full", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-repo-"));
    await initBareGitRepo(repo);
    await saveSettings(dataDir, { maxActiveJobs: 1 });
    await seedJob(dataDir, repo, "feat/running");
    const engine = new RunnerEngine(testConfig(dataDir));
    const args = { repoPath: repo, branch: "feat/x", promptFile: prompt, dryRun: true };

    const queued = await engine.startJob(args);
    assert.equal(queued.queueState?.queued, true);
    await assert.rejects(engine.startJob(args), BranchConflictError);
  });

  it("serializes concurrent same-branch starts so only one is accepted", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-race-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-race-repo-"));
    await initBareGitRepo(repo);
    await saveSettings(dataDir, { maxActiveJobs: 1 });
    await seedJob(dataDir, repo, "feat/running");
    const engine = new RunnerEngine(testConfig(dataDir));
    const args = { repoPath: repo, branch: "feat/x", promptFile: prompt, dryRun: true };

    const results = await Promise.allSettled([1, 2, 3].map(() => engine.startJob(args)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) {
      if (r.status === "rejected") assert.ok(r.reason instanceof BranchConflictError);
    }
  });

  it("raising maxActiveJobs starts queued jobs without waiting for a running job to finish", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-cap-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-cap-repo-"));
    await initBareGitRepo(repo);
    await saveSettings(dataDir, { maxActiveJobs: 1 });
    const engine = new RunnerEngine(testConfig(dataDir), { watchCi: false });
    const jobArgs = (branch: string) => ({
      repoPath: repo,
      branch,
      promptFile: prompt,
      maxRounds: 1,
      dryRun: true,
    });
    const running = await engine.startJob(jobArgs("feat/running"));
    assert.equal(running.queueState?.queued, undefined);
    const queued = await engine.startJob(jobArgs("feat/queued"));
    assert.equal(queued.queueState?.queued, true);
    assert.equal(engine.isRunning(running.id), true);
    assert.equal(engine.isRunning(queued.id), false);

    const prior = await loadSettings(dataDir);
    await saveSettings(dataDir, { maxActiveJobs: 2 });
    await engine.settingsSaved(prior.maxActiveJobs);

    const dequeued = await loadJob(dataDir, queued.id);
    assert.equal(dequeued?.queueState?.queued, undefined);
    assert.equal(engine.isRunning(queued.id), true, "queued job should start while the first still runs");

    await waitForIdle(engine, [running.id, queued.id]);
  });

  it("drainQueue fills every free slot", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-drain-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-drain-repo-"));
    await initBareGitRepo(repo);
    await saveSettings(dataDir, { maxActiveJobs: 2 });
    const jobs = [
      await seedJob(dataDir, repo, "q1", true),
      await seedJob(dataDir, repo, "q2", true),
      await seedJob(dataDir, repo, "q3", true),
    ];
    const engine = new RunnerEngine(testConfig(dataDir), { watchCi: false });
    try {
      await engine.init();
      const dequeued: string[] = [];
      for (const j of jobs) {
        const live = await loadJob(dataDir, j.id);
        if (!live?.queueState?.queued) dequeued.push(j.id);
      }
      assert.ok(dequeued.length >= 2, `expected both free slots used, got ${dequeued.length}`);

      await waitForIdle(
        engine,
        jobs.map((j) => j.id),
      );
      for (const j of jobs) {
        const done = await loadJob(dataDir, j.id);
        assert.equal(done?.stage, "approved", `${j.input.branch}: ${done?.error ?? ""}`);
      }
    } finally {
      await waitForIdle(
        engine,
        jobs.map((j) => j.id),
      );
    }
  });

  it("stopping a queued job marks it stopped so it can be archived", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-stop-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-stop-repo-"));
    const job = await seedJob(dataDir, repo, "feat/q", true);
    const engine = new RunnerEngine(testConfig(dataDir));

    const stopped = await engine.stop(job.id);
    assert.equal(stopped?.stage, "stopped");
    assert.equal(stopped?.queueState, undefined);
    const archived = await engine.archive(job.id);
    assert.equal(archived.ok, true);
  });

  it("a queued job can be archived without stopping it first", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-arch-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-engine-q-arch-repo-"));
    const job = await seedJob(dataDir, repo, "feat/q", true);
    const engine = new RunnerEngine(testConfig(dataDir));
    const archived = await engine.archive(job.id);
    assert.equal(archived.ok, true);
  });
});
