import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_JOB_HIDE_AFTER_MS,
  formatRelativeTime,
  shouldHideStaleJob,
} from "./dashboard-format.js";
import type { JobRecord } from "./types.js";

function baseJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "failed",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: null,
    prNumber: null,
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
    ...overrides,
  };
}

describe("shouldHideStaleJob", () => {
  it("hides old failed jobs with no PR or ticket", () => {
    const updated = Date.parse("2026-01-01T10:00:00.000Z");
    const job = baseJob({ updatedAt: new Date(updated).toISOString(), stage: "failed" });
    assert.equal(shouldHideStaleJob(job, updated + STALE_JOB_HIDE_AFTER_MS), true);
  });

  it("keeps recent failed jobs visible", () => {
    const updated = Date.parse("2026-01-01T10:00:00.000Z");
    const job = baseJob({ updatedAt: new Date(updated).toISOString(), stage: "stopped" });
    assert.equal(shouldHideStaleJob(job, updated + STALE_JOB_HIDE_AFTER_MS - 1), false);
  });

  it("does not hide when a PR is linked", () => {
    const updated = Date.parse("2026-01-01T10:00:00.000Z");
    const job = baseJob({
      updatedAt: new Date(updated).toISOString(),
      prUrl: "https://github.com/o/r/pull/1",
    });
    assert.equal(shouldHideStaleJob(job, updated + STALE_JOB_HIDE_AFTER_MS + 1), false);
  });

  it("does not hide active stages", () => {
    const updated = Date.parse("2026-01-01T10:00:00.000Z");
    const job = baseJob({ updatedAt: new Date(updated).toISOString(), stage: "building" });
    assert.equal(shouldHideStaleJob(job, updated + STALE_JOB_HIDE_AFTER_MS + 1), false);
  });
});

describe("formatRelativeTime", () => {
  it("returns just now for recent timestamps", () => {
    const now = Date.parse("2026-01-01T12:00:30.000Z");
    const r = formatRelativeTime("2026-01-01T12:00:00.000Z", now, "en-US");
    assert.equal(r.label, "just now");
    assert.match(r.title, /2026/);
  });

  it("returns minutes and hours ago", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    assert.equal(formatRelativeTime("2026-01-01T11:50:00.000Z", now, "en-US").label, "10m ago");
    assert.equal(formatRelativeTime("2026-01-01T09:00:00.000Z", now, "en-US").label, "3h ago");
  });
});
