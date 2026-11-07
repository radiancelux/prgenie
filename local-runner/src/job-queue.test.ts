import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JobRecord } from "./types.js";
import { decideJobStart, runnableQueuedJobs } from "./job-queue.js";

function job(partial: Partial<JobRecord>): JobRecord {
  return {
    id: partial.id ?? "j",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    input: partial.input ?? { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: partial.stage ?? "building",
    reviewRound: 0,
    maxRounds: 3,
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
    title: "t",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
    ...partial,
  };
}

const queued = { queued: true, since: "2026-01-01T00:00:00.000Z" };

function onBranch(branch: string, partial: Partial<JobRecord> = {}): JobRecord {
  return job({ input: { repoPath: "/r", branch, promptFile: "/p" }, ...partial });
}

describe("job queue", () => {
  it("rejects a second job on the same branch", () => {
    const jobs = [onBranch("feat/x", { id: "a" })];
    const d = decideJobStart(jobs, "feat/x", "o/r", 2);
    assert.equal(d.action, "reject");
  });

  it("matches on repo slug, so remote-only and path starts of one repo collide", () => {
    const jobs = [
      onBranch("feat/x", {
        id: "a",
        input: { repoPath: "", remote: "https://github.com/o/r", branch: "feat/x", promptFile: "" },
      }),
    ];
    assert.equal(decideJobStart(jobs, "feat/x", "o/r", 2).action, "reject");
    assert.equal(decideJobStart(jobs, "feat/x", "other/repo", 2).action, "run");
  });

  it("queues when active cap is reached", () => {
    const jobs = [job({ id: "1", stage: "building" }), job({ id: "2", stage: "reviewing" })];
    const d = decideJobStart(jobs, "feat/other", "o/r", 2);
    assert.equal(d.action, "queue");
    if (d.action === "queue") assert.equal(d.position, 1);
  });

  it("rejects a duplicate same-branch submission while the cap is full", () => {
    const jobs = [
      onBranch("a", { id: "1" }),
      onBranch("b", { id: "2" }),
      onBranch("feat/x", { id: "3", queueState: queued }),
    ];
    const d = decideJobStart(jobs, "feat/x", "o/r", 2);
    assert.equal(d.action, "reject");
  });

  it("ignores stopped jobs when checking the branch", () => {
    const jobs = [onBranch("feat/x", { id: "a", stopRequested: true })];
    assert.equal(decideJobStart(jobs, "feat/x", "o/r", 2).action, "run");
  });

  it("a stop-requested job still unwinding keeps its branch and slot", () => {
    const jobs = [onBranch("feat/x", { id: "a", stopRequested: true })];
    const isRunning = (id: string) => id === "a";
    assert.equal(decideJobStart(jobs, "feat/x", "o/r", 2, { isRunning }).action, "reject");
    assert.equal(decideJobStart(jobs, "feat/y", "o/r", 1, { isRunning }).action, "queue");
    assert.equal(
      decideJobStart(jobs, "feat/x", "o/r", 2, { isRunning: () => false }).action,
      "run",
    );
  });
});

describe("runnableQueuedJobs", () => {
  it("fills every free slot, oldest first", () => {
    const jobs = [
      onBranch("q3", { id: "q3", queueState: queued, createdAt: "2026-01-03T00:00:00.000Z" }),
      onBranch("q1", { id: "q1", queueState: queued, createdAt: "2026-01-01T00:00:00.000Z" }),
      onBranch("q2", { id: "q2", queueState: queued, createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    assert.deepEqual(
      runnableQueuedJobs(jobs, 2).map((j) => j.id),
      ["q1", "q2"],
    );
  });

  it("skips stop-requested queued jobs and branches that are already running", () => {
    const jobs = [
      onBranch("feat/x", { id: "running" }),
      onBranch("feat/x", { id: "dup", queueState: queued, createdAt: "2026-01-01T00:00:00.000Z" }),
      onBranch("stop", {
        id: "stopped",
        queueState: queued,
        stopRequested: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      onBranch("ok", { id: "ok", queueState: queued, createdAt: "2026-01-03T00:00:00.000Z" }),
    ];
    assert.deepEqual(
      runnableQueuedJobs(jobs, 3).map((j) => j.id),
      ["ok"],
    );
  });

  it("does not hand a stop-requested job's slot out until its loop exits", () => {
    const jobs = [
      onBranch("busy", { id: "stopping", stopRequested: true }),
      onBranch("q", { id: "q", queueState: queued }),
    ];
    assert.deepEqual(runnableQueuedJobs(jobs, 1, { isRunning: (id) => id === "stopping" }), []);
    assert.deepEqual(
      runnableQueuedJobs(jobs, 1, { isRunning: () => false }).map((j) => j.id),
      ["q"],
    );
  });
});
