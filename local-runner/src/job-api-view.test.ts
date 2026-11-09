import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichJobPublicView, jobActivityMessage } from "./job-api-view.js";
import type { JobRecord } from "./types.js";

function job(partial: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    input: { repoPath: "/r", branch: "feat/target", promptFile: "/p" },
    stage: "building",
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
    title: "t",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: false,
    archivedAt: null,
    ...partial,
  };
}

describe("enrichJobPublicView", () => {
  it("fills branch from input and clears a misleading null top-level branch (#204)", () => {
    const legacy = { ...job(), branch: null } as JobRecord & { branch: null };
    const view = enrichJobPublicView(legacy);
    assert.equal(view.branch, "feat/target");
    assert.equal(view.input.branch, "feat/target");
  });

  it("exposes queued and queuePosition (#203)", () => {
    const view = enrichJobPublicView(
      job({ queueState: { queued: true, position: 2, since: "2026-01-01T00:00:00.000Z" } }),
    );
    assert.equal(view.queued, true);
    assert.equal(view.queuePosition, 2);
    assert.match(view.activityMessage ?? "", /Queued \(position 2\)/);
  });

  it("reports preparing worktree when building without a worktree", () => {
    assert.equal(
      jobActivityMessage(job({ stage: "building", worktreePath: null })),
      "Preparing worktree",
    );
  });
});
