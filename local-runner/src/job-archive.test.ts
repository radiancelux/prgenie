import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { archiveJob, clearFailedJobs, restoreJob } from "./job-archive.js";
import { archivedJobFile, archivedLogFile, isSafeJobId, jobFile, jobLogFile } from "./paths.js";
import {
  jobsDashboardMeta,
  listJobs,
  listJobsForDisplay,
  loadArchivedJob,
  loadJob,
  saveJob,
} from "./store.js";
import type { JobRecord, JobStage } from "./types.js";

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

function job(dataDir: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const id = overrides.id ?? "job-1";
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    input: { repoPath: "/repo", branch: "feat/x", promptFile: "/p" },
    stage: "failed",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: "x",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: jobLogFile(dataDir, id),
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
    ...overrides,
  };
}

async function seed(dataDir: string, overrides: Partial<JobRecord> = {}): Promise<JobRecord> {
  const j = job(dataDir, overrides);
  await mkdir(path.dirname(jobLogFile(dataDir, j.id)), { recursive: true });
  await writeFile(jobLogFile(dataDir, j.id), `log for ${j.id}\n`, "utf8");
  await saveJob(dataDir, j);
  return j;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function tmpDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "lr-archive-"));
}

describe("job archive round-trip", () => {
  it("moves job JSON and log under archived/ and restores both", async () => {
    const dataDir = await tmpDataDir();
    const config = testConfig(dataDir);
    await seed(dataDir);

    const archived = await archiveJob(config, "job-1");
    assert.ok(archived.ok);
    assert.equal(archived.worktree, "none");
    assert.equal(await exists(jobFile(dataDir, "job-1")), false);
    assert.equal(await exists(jobLogFile(dataDir, "job-1")), false);
    assert.equal(await exists(archivedJobFile(dataDir, "job-1")), true);
    assert.equal(await readFile(archivedLogFile(dataDir, "job-1"), "utf8"), "log for job-1\n");
    const onDisk = await loadArchivedJob(dataDir, "job-1");
    assert.ok(onDisk?.archivedAt);
    assert.equal(onDisk?.logPath, archivedLogFile(dataDir, "job-1"));

    assert.deepEqual(await listJobs(dataDir), []);
    assert.deepEqual(
      (await listJobs(dataDir, { includeArchived: true })).map((j) => j.id),
      ["job-1"],
    );
    assert.deepEqual(await listJobsForDisplay(dataDir), []);
    assert.equal(
      (await listJobsForDisplay(dataDir, Date.now(), { includeArchived: true })).length,
      1,
    );
    assert.deepEqual(await jobsDashboardMeta(dataDir), {
      totalOnDisk: 0,
      mergedHidden: 0,
      archived: 1,
    });

    const restored = await restoreJob(config, "job-1");
    assert.ok(restored.ok);
    assert.equal(await exists(archivedJobFile(dataDir, "job-1")), false);
    assert.equal(await exists(archivedLogFile(dataDir, "job-1")), false);
    const live = await loadJob(dataDir, "job-1");
    assert.equal(live?.archivedAt, null);
    assert.equal(live?.logPath, jobLogFile(dataDir, "job-1"));
    assert.equal(await readFile(jobLogFile(dataDir, "job-1"), "utf8"), "log for job-1\n");
  });

  it("a stale save after archiving does not resurrect the live job", async () => {
    const dataDir = await tmpDataDir();
    const stale = await seed(dataDir);
    assert.ok((await archiveJob(testConfig(dataDir), "job-1")).ok);
    stale.ciStatus = { status: "success", checkedAt: "", source: "github" };
    await saveJob(dataDir, stale);
    assert.equal(await exists(jobFile(dataDir, "job-1")), false);
    assert.equal((await loadArchivedJob(dataDir, "job-1"))?.ciStatus, null);
  });

  it("restore rejects an id that collides with a live job", async () => {
    const dataDir = await tmpDataDir();
    const config = testConfig(dataDir);
    await seed(dataDir);
    assert.ok((await archiveJob(config, "job-1")).ok);
    await writeFile(jobFile(dataDir, "job-1"), JSON.stringify(job(dataDir)), "utf8");

    const res = await restoreJob(config, "job-1");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "collision");
    assert.equal(await exists(archivedJobFile(dataDir, "job-1")), true, "archive untouched");
  });

  it("rejects running jobs and leaves their files in place", async () => {
    const dataDir = await tmpDataDir();
    const config = testConfig(dataDir);
    for (const stage of ["building", "reviewing", "fixing"] as JobStage[]) {
      await seed(dataDir, { id: `run-${stage}`, stage });
      const res = await archiveJob(config, `run-${stage}`);
      assert.equal(res.ok, false, stage);
      if (!res.ok) {
        assert.equal(res.code, "running");
        assert.equal(res.stage, stage);
      }
      assert.equal(await exists(jobFile(dataDir, `run-${stage}`)), true);
    }
    // Terminal on disk but the engine loop has not settled yet.
    await seed(dataDir, { id: "settling", stage: "stopped" });
    const res = await archiveJob(config, "settling", { isRunning: (id) => id === "settling" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "running");
  });

  it("rejects path-traversal ids before touching the filesystem", async () => {
    const dataDir = await tmpDataDir();
    const config = testConfig(dataDir);
    await writeFile(path.join(dataDir, "settings.json"), "{}", "utf8");
    for (const id of ["../settings", "..", "a/b", "a\\b", "x.json", ""]) {
      assert.equal(isSafeJobId(id), false, id);
      const archived = await archiveJob(config, id);
      assert.equal(archived.ok, false);
      if (!archived.ok) assert.equal(archived.code, "invalid_id");
      const restored = await restoreJob(config, id);
      assert.equal(restored.ok, false);
      if (!restored.ok) assert.equal(restored.code, "invalid_id");
      assert.equal(await loadJob(dataDir, id), null);
    }
    assert.equal(await exists(path.join(dataDir, "settings.json")), true);
  });
});

describe("clearFailedJobs", () => {
  async function seedAllStages(dataDir: string): Promise<void> {
    const stages: JobStage[] = [
      "building",
      "reviewing",
      "fixing",
      "approved",
      "changes_remaining",
      "stuck",
      "failed",
      "stopped",
    ];
    for (const stage of stages) await seed(dataDir, { id: `job-${stage}`, stage });
  }

  it("archives only failed jobs by default", async () => {
    const dataDir = await tmpDataDir();
    await seedAllStages(dataDir);
    const res = await clearFailedJobs(testConfig(dataDir));
    assert.deepEqual(res.archived, ["job-failed"]);
    assert.deepEqual(res.stages, ["failed"]);
    assert.equal((await listJobs(dataDir)).length, 7);
  });

  it("also archives stuck and stopped jobs when opted in, never running ones", async () => {
    const dataDir = await tmpDataDir();
    await seedAllStages(dataDir);
    const res = await clearFailedJobs(testConfig(dataDir), { includeStuckStopped: true });
    assert.deepEqual([...res.archived].sort(), ["job-failed", "job-stopped", "job-stuck"]);
    assert.deepEqual((await listJobs(dataDir)).map((j) => j.stage).sort(), [
      "approved",
      "building",
      "changes_remaining",
      "fixing",
      "reviewing",
    ]);
  });

  it("skips a matching job whose loop is still running", async () => {
    const dataDir = await tmpDataDir();
    await seed(dataDir, { id: "job-a", stage: "failed" });
    await seed(dataDir, { id: "job-b", stage: "failed" });
    const res = await clearFailedJobs(testConfig(dataDir), { isRunning: (id) => id === "job-b" });
    assert.deepEqual(res.archived, ["job-a"]);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].id, "job-b");
  });
});

describe("archive worktree safety", () => {
  it("keeps a dirty worktree with a warning and never force-removes it", async () => {
    const dataDir = await tmpDataDir();
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-archive-wt-"));
    await writeFile(path.join(wt, "dirty.txt"), "wip", "utf8");
    await seed(dataDir, { worktreePath: wt, input: { repoPath: wt, branch: "b", promptFile: "" } });
    const calls: string[][] = [];
    const gitImpl = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return { code: 0, stdout: "?? dirty.txt\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await archiveJob(testConfig(dataDir), "job-1", { gitImpl: gitImpl as never });
    assert.ok(res.ok);
    assert.equal(res.worktree, "kept");
    assert.match(res.warning ?? "", /uncommitted changes/);
    assert.match(res.warning ?? "", new RegExp(wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await exists(path.join(wt, "dirty.txt")), true, "dirty tree untouched");
    assert.ok(!calls.some((a) => a[0] === "worktree"), "no worktree remove attempted");
    const archived = await loadArchivedJob(dataDir, "job-1");
    assert.equal(archived?.worktreePath, wt, "kept path stays on the record");
  });

  it("keeps a clean worktree whose branch has unpushed commits", async () => {
    const dataDir = await tmpDataDir();
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-archive-wt-"));
    await seed(dataDir, { worktreePath: wt, input: { repoPath: wt, branch: "b", promptFile: "" } });
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args.includes("HEAD")) return { code: 0, stdout: "aaa\n", stderr: "" };
      if (args.includes("origin/b")) return { code: 0, stdout: "bbb\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await archiveJob(testConfig(dataDir), "job-1", { gitImpl: gitImpl as never });
    assert.ok(res.ok);
    assert.equal(res.worktree, "kept");
    assert.match(res.warning ?? "", /not on origin/);
    assert.equal(await exists(wt), true);
  });

  it("removes a clean, pushed worktree so the branch is free (even if it exists on origin)", async () => {
    const dataDir = await tmpDataDir();
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-archive-repo-"));
    const wt = path.join(repo, "wt");
    await mkdir(wt, { recursive: true });
    await seed(dataDir, {
      stage: "failed",
      worktreePath: wt,
      input: { repoPath: repo, branch: "b", promptFile: "" },
    });
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "same\n", stderr: "" };
      if (args[0] === "ls-remote") return { code: 0, stdout: "abc\trefs/heads/b\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await archiveJob(testConfig(dataDir), "job-1", { gitImpl: gitImpl as never });
    assert.ok(res.ok);
    assert.equal(res.worktree, "removed");
    assert.equal(res.warning, undefined);
    assert.equal(await exists(wt), false);
    assert.equal((await loadArchivedJob(dataDir, "job-1"))?.worktreePath, null);
  });
});
