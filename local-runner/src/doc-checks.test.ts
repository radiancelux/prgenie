import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldPollCi } from "./ci.js";
import { isDocsJob, rollupDocCheckResult, shouldPollDocChecks } from "./doc-checks.js";
import type { JobRecord } from "./types.js";

function baseJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "" },
    stage: "approved",
    reviewRound: 1,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    prIsDraft: true,
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
    ...overrides,
  };
}

describe("docs job CI routing", () => {
  it("docs jobs skip GitHub CI polling", () => {
    const job = baseJob({
      input: { repoPath: "/r", branch: "b", promptFile: "", jobType: "docs" },
    });
    assert.equal(shouldPollCi(job), false);
    assert.equal(shouldPollDocChecks(job), true);
  });

  it("code jobs still poll CI", () => {
    const job = baseJob({ stage: "building" });
    assert.equal(shouldPollCi(job), true);
    assert.equal(shouldPollDocChecks(job), false);
  });
});

describe("doc check rollup", () => {
  it("fail soft keeps neutral status", () => {
    const r = rollupDocCheckResult(
      { ok: false, skipped: false, summary: "lint failed", detail: "x" },
      { enabled: true, failHard: false },
    );
    assert.equal(r.status, "neutral");
    assert.match(r.summary, /warning \(non-blocking\)/);
  });

  it("fail hard stays failure", () => {
    const r = rollupDocCheckResult(
      { ok: false, skipped: false, summary: "lint failed", detail: "x" },
      { enabled: true, failHard: true },
    );
    assert.equal(r.status, "failure");
  });

  it("disabled checks are N/A success", () => {
    const r = rollupDocCheckResult(
      { ok: false, skipped: false, summary: "lint failed" },
      { enabled: false, failHard: true },
    );
    assert.equal(r.status, "success");
    assert.equal(r.summary, "N/A");
  });
});

describe("isDocsJob", () => {
  it("detects profile alias", () => {
    const job = baseJob({
      input: { repoPath: "/r", branch: "b", promptFile: "", profile: "docs" },
    });
    assert.equal(isDocsJob(job), true);
  });
});
