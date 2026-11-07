import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JobRecord } from "./types.js";
import { decideJobStart } from "./job-queue.js";

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

describe("job queue", () => {
  it("rejects a second job on the same branch", () => {
    const jobs = [job({ id: "a", input: { repoPath: "/r", branch: "feat/x", promptFile: "/p" } })];
    const d = decideJobStart(jobs, "feat/x", "/r", 2);
    assert.equal(d.action, "reject");
  });

  it("queues when active cap is reached", () => {
    const jobs = [job({ id: "1", stage: "building" }), job({ id: "2", stage: "reviewing" })];
    const d = decideJobStart(jobs, "feat/other", "/r", 2);
    assert.equal(d.action, "queue");
    if (d.action === "queue") assert.equal(d.position, 1);
  });
});
