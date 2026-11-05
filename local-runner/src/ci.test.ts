import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCiFinal,
  rollupCheckStatuses,
  rollupFromGithubStatusCheckRollup,
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

  it("stops polling when CI is final", () => {
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
      false,
    );
  });

  it("does not poll archived merged jobs", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        archivedAt: "2026-11-05T12:00:00.000Z",
        ciStatus: { status: "pending", checkedAt: "", source: "github" },
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
});

describe("isCiFinal", () => {
  it("treats success and failure as final", () => {
    assert.equal(isCiFinal("success"), true);
    assert.equal(isCiFinal("failure"), true);
    assert.equal(isCiFinal("pending"), false);
  });
});
