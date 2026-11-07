import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import { CiWatcher } from "./ci-watcher.js";
import { createJob, loadJob, saveJob } from "./store.js";

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

const fakeEngine = { emit: () => true } as unknown as RunnerEngine;

describe("CiWatcher", () => {
  it("a refresh that loaded the job mid-build never rolls stage back", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-ciw-"));
    const config = testConfig(dataDir);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true, config },
    );
    job.prUrl = "https://github.com/example/example/pull/1";
    job.prNumber = 1;
    await saveJob(dataDir, job);

    const watcher = new CiWatcher(config, fakeEngine, {
      fetchPrCiStatus: async () => {
        const live = await loadJob(dataDir, job.id);
        live!.stage = "approved";
        live!.lastVerdict = "APPROVE";
        await saveJob(dataDir, live!);
        return { status: "success", summary: "ok", source: "github" };
      },
      syncDraftReadyForJob: async (j) => ({ job: j, changed: false }),
      cleanupWorktree: async () => {},
    });
    await watcher.refreshJobById(job.id);

    const after = await loadJob(dataDir, job.id);
    assert.equal(after?.stage, "approved");
    assert.equal(after?.lastVerdict, "APPROVE");
    assert.equal(after?.ciStatus?.status, "success");
  });

  it("draft sync patches only the fields it changed", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-ciw-draft-"));
    const config = testConfig(dataDir);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true, config },
    );
    job.prUrl = "https://github.com/example/example/pull/1";
    job.prNumber = 1;
    await saveJob(dataDir, job);

    const watcher = new CiWatcher(config, fakeEngine, {
      fetchPrCiStatus: async () => {
        const live = await loadJob(dataDir, job.id);
        live!.stage = "reviewing";
        await saveJob(dataDir, live!);
        return { status: "pending", source: "github" };
      },
      syncDraftReadyForJob: async (j) => {
        j.prIsDraft = true;
        j.error = "pr ready: nope";
        return { job: j, changed: true, errorNote: "pr ready: nope" };
      },
      cleanupWorktree: async () => {},
    });
    await watcher.refreshJobById(job.id);

    const after = await loadJob(dataDir, job.id);
    assert.equal(after?.stage, "reviewing");
    assert.equal(after?.prIsDraft, true);
    assert.equal(after?.error, "pr ready: nope");
  });
});
