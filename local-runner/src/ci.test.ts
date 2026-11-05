import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGhPrViewArgs,
  fetchPrCiStatus,
  firstStderrLine,
  GH_PR_VIEW_JSON,
  isCiFinal,
  MERGED_HIDE_AFTER_MS,
  repoSlugFromPrUrl,
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
    driverId: "cursor-agent",
    worktreePath: "/wt",
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
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

  it("maps mergeable CONFLICTING to merge conflict", () => {
    const r = resolveDisplayStatus({ mergeable: "CONFLICTING" }, "success");
    assert.equal(r.status, "merge_conflict");
  });

  it("maps closed PR state", () => {
    assert.equal(resolveDisplayStatus({ state: "CLOSED" }, "success").status, "closed");
  });

  it("passes through CI rollup when PR is open and clean", () => {
    assert.equal(
      resolveDisplayStatus({ state: "OPEN", mergeable: "MERGEABLE" }, "pending").status,
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
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
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

describe("buildGhPrViewArgs", () => {
  it("never requests mergeableState from gh", () => {
    assert.doesNotMatch(GH_PR_VIEW_JSON, /mergeableState/);
    const args = buildGhPrViewArgs("radiancelux/prgenie", { prNumber: 105 });
    assert.ok(args);
    assert.deepEqual(args, [
      "pr",
      "view",
      "105",
      "--json",
      GH_PR_VIEW_JSON,
      "--repo",
      "radiancelux/prgenie",
    ]);
  });

  it("derives repo slug from pr URL when building lookup target", () => {
    assert.equal(
      repoSlugFromPrUrl("https://github.com/radiancelux/prgenie/pull/106"),
      "radiancelux/prgenie",
    );
  });
});

describe("fetchPrCiStatus", () => {
  it("returns merged status from gh rollup", async () => {
    const stdout = JSON.stringify({
      state: "MERGED",
      mergedAt: "2026-01-01T12:00:00Z",
      url: "https://github.com/o/r/pull/1",
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const r = await fetchPrCiStatus(
      null,
      { prNumber: 1, repoSlug: "o/r" },
      {
        gh: async (_cwd, args) => {
          assert.doesNotMatch(args.join(" "), /mergeableState/);
          assert.ok(args.includes("--repo"));
          return { code: 0, stdout, stderr: "" };
        },
      },
    );
    assert.equal(r.status, "merged");
    assert.equal(r.summary, "merged");
  });

  it("returns unknown with reason when gh fails", async () => {
    const r = await fetchPrCiStatus(
      null,
      { prNumber: 2, repoSlug: "o/r" },
      {
        gh: async () => ({
          code: 1,
          stdout: "",
          stderr: 'Unknown JSON field: "mergeableState"\n',
        }),
      },
    );
    assert.equal(r.status, "unknown");
    assert.equal(r.summary, "CI unknown");
    assert.match(r.reason ?? "", /mergeableState/);
  });

  it("maps pending and failing CI from gh checks rollup", async () => {
    const pendingOut = JSON.stringify({
      state: "OPEN",
      mergeable: "MERGEABLE",
      url: "https://github.com/o/r/pull/3",
      statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }],
    });
    const pending = await fetchPrCiStatus(
      null,
      { prNumber: 3, repoSlug: "o/r" },
      { gh: async () => ({ code: 0, stdout: pendingOut, stderr: "" }) },
    );
    assert.equal(pending.status, "pending");

    const failOut = JSON.stringify({
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }],
    });
    const failed = await fetchPrCiStatus(
      null,
      { prNumber: 4, repoSlug: "o/r" },
      { gh: async () => ({ code: 0, stdout: failOut, stderr: "" }) },
    );
    assert.equal(failed.status, "failure");
  });
});

describe("firstStderrLine", () => {
  it("returns the first non-empty stderr line", () => {
    assert.equal(firstStderrLine("\n\nboom\nrest"), "boom");
  });
});
