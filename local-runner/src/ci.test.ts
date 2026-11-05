import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCiFinal,
  MERGED_HIDE_AFTER_MS,
  resolveDisplayStatus,
  rollupCheckStatuses,
  rollupFromGithubStatusCheckRollup,
  shouldHideMergedJob,
  shouldPollCi,
} from "./ci.js";
import type { JobRecord } from "./types.js";

describe("rollupCheckStatuses", () => {
  it("maps pending when any check is in progress", () => {
    const r = rollupCheckStatuses([
      { name: "build-test", status: "IN_PROGRESS" },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.equal(r.status, "pending");
  });

  it("maps failure when any check failed", () => {
    const r = rollupCheckStatuses([
      { name: "build-test", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    assert.equal(r.status, "failure");
  });

  it("maps success when all completed successfully", () => {
    const r = rollupCheckStatuses([
      { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "b", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.equal(r.status, "success");
  });
});

describe("rollupFromGithubStatusCheckRollup", () => {
  it("accepts GitHub statusCheckRollup rows", () => {
    const r = rollupFromGithubStatusCheckRollup([
      {
        name: "build-test",
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
    ]);
    assert.equal(r.status, "failure");
  });
});

describe("shouldPollCi", () => {
  const base: JobRecord = {
    id: "j",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    worktreePath: "/wt",
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    linearIssue: null,
    ticketUrl: null,
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
  };

  it("does not poll failed jobs without a PR", () => {
    assert.equal(shouldPollCi({ ...base, stage: "failed", prUrl: null, prNumber: null }), false);
  });

  it("stops polling when CI is final during active build stages", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "building",
        ciStatus: {
          status: "success",
          checkedAt: "",
          source: "github",
        },
      }),
      false,
    );
  });

  it("does not poll when ciStatus reports merged", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: {
          status: "merged",
          mergedAt: "2026-11-05T12:00:00.000Z",
          checkedAt: "",
          source: "github",
        },
      }),
      false,
    );
  });

  it("polls approved jobs while CI is pending", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: { status: "pending", checkedAt: "", source: "github" },
      }),
      true,
    );
  });

  it("stops polling once PR is merged", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: {
          status: "merged",
          mergedAt: "2026-01-01T12:00:00Z",
          checkedAt: "",
          source: "github",
        },
      }),
      false,
    );
  });

  it("keeps polling approved jobs with green CI until merge is known", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: {
          status: "success",
          checkedAt: "",
          source: "github",
        },
      }),
      true,
    );
  });
});

describe("isCiFinal", () => {
  it("treats success and failure as final", () => {
    assert.equal(isCiFinal("success"), true);
    assert.equal(isCiFinal("failure"), true);
    assert.equal(isCiFinal("pending"), false);
    assert.equal(isCiFinal("merged"), false);
  });
});

describe("resolveDisplayStatus", () => {
  it("maps merged PR state", () => {
    const r = resolveDisplayStatus(
      { state: "MERGED", mergedAt: "2026-01-01T12:00:00Z" },
      "success",
    );
    assert.equal(r.status, "merged");
    assert.equal(r.mergedAt, "2026-01-01T12:00:00Z");
  });

  it("maps dirty mergeable state to merge conflict", () => {
    const r = resolveDisplayStatus({ mergeableState: "DIRTY" }, "success");
    assert.equal(r.status, "merge_conflict");
  });

  it("passes through CI rollup when PR is open and clean", () => {
    assert.equal(
      resolveDisplayStatus({ state: "OPEN", mergeableState: "CLEAN" }, "pending").status,
      "pending",
    );
  });
});

describe("shouldHideMergedJob", () => {
  const mergedJob: JobRecord = {
    id: "j",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "approved",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    linearIssue: null,
    ticketUrl: null,
    tokenUsage: null,
    ciStatus: {
      status: "merged",
      mergedAt: "2026-01-01T12:00:00Z",
      checkedAt: "",
      source: "github",
    },
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
  };

  it("keeps merged jobs visible before hide window", () => {
    const mergedAt = Date.parse("2026-01-01T12:00:00Z");
    assert.equal(shouldHideMergedJob(mergedJob, mergedAt + MERGED_HIDE_AFTER_MS - 1), false);
  });

  it("hides merged jobs after hide window", () => {
    const mergedAt = Date.parse("2026-01-01T12:00:00Z");
    assert.equal(shouldHideMergedJob(mergedJob, mergedAt + MERGED_HIDE_AFTER_MS), true);
  });
});
