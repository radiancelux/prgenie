import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatCiSkipBody,
  isReadyCiSatisfied,
  parseCiSkipReason,
  readyCiBlockMessage,
  readyCiFromSkipReason,
  upsertReviewRequestedComment,
} from "./ready-ci.js";
import { formatSessionReconcileDigest, rowForLoop } from "./session-reconcile.js";
import { decideStewardAction } from "./steward.js";
import type { LocalPr } from "./types.js";

describe("RAD-97 ready CI / review interrupt", { concurrency: 1 }, () => {
  test("parseCiSkipReason and formatCiSkipBody", () => {
    assert.equal(parseCiSkipReason("CI skipped: toolchain missing"), "toolchain missing");
    assert.equal(parseCiSkipReason("Review requested."), null);
    assert.equal(formatCiSkipBody("no node"), "CI skipped: no node");
    assert.equal(formatCiSkipBody("CI skipped: already"), "CI skipped: already");
  });

  test("isReadyCiSatisfied requires matching tip", () => {
    const pr = {
      id: "lp-x",
      headSha: "aaa",
      readyCi: readyCiFromSkipReason("bbb", "old tip"),
      comments: [],
    } as unknown as LocalPr;
    assert.equal(isReadyCiSatisfied(pr, "aaa"), false);
    assert.equal(isReadyCiSatisfied(pr, "bbb"), true);
    assert.match(readyCiBlockMessage(pr), /Ready blocked \(RAD-97\)/);
  });

  test("passed readyCi satisfies tip", () => {
    const pr = {
      id: "lp-x",
      headSha: "abc",
      readyCi: {
        headSha: "abc",
        recordedAt: new Date().toISOString(),
        outcome: "passed" as const,
        checks: ["lint"],
      },
      comments: [],
    } as unknown as LocalPr;
    assert.equal(isReadyCiSatisfied(pr), true);
  });

  test("CI skipped comment satisfies without readyCi field", () => {
    const pr = {
      id: "lp-x",
      headSha: "abc",
      readyCi: null,
      comments: [
        {
          id: "c1",
          body: "CI skipped: no toolchain",
          createdAt: new Date().toISOString(),
          author: "agent",
          role: "agent",
          status: "resolved",
        },
      ],
    } as unknown as LocalPr;
    assert.equal(isReadyCiSatisfied(pr), true);
  });

  test("upsertReviewRequestedComment once per SHA", () => {
    const pr = {
      comments: [] as LocalPr["comments"],
    } as LocalPr;
    assert.equal(
      upsertReviewRequestedComment(pr, "2026-01-01T00:00:00.000Z", "a", "sha1", "c-1"),
      true,
    );
    assert.equal(
      upsertReviewRequestedComment(pr, "2026-01-02T00:00:00.000Z", "a", "sha1", "c-2"),
      false,
    );
    assert.equal(pr.comments.length, 1);
    assert.equal(pr.comments[0]?.forSha, "sha1");
    assert.equal(
      upsertReviewRequestedComment(pr, "2026-01-03T00:00:00.000Z", "a", "sha2", "c-3"),
      true,
    );
    assert.equal(pr.comments.length, 2);
  });

  test("upsertReviewRequestedComment reuses legacy root", () => {
    const pr = {
      comments: [
        {
          id: "c-old",
          body: "Review requested.",
          createdAt: "2026-01-01T00:00:00.000Z",
          author: "agent",
          role: "agent" as const,
          status: "resolved" as const,
        },
      ],
    } as LocalPr;
    const added = upsertReviewRequestedComment(
      pr,
      "2026-01-02T00:00:00.000Z",
      "agent",
      "abc123",
      "c-new",
    );
    assert.equal(added, false);
    assert.equal(pr.comments.length, 1);
    assert.equal(pr.comments[0]?.forSha, "abc123");
  });

  test("decideStewardAction resume_reviewer on review_interrupted", () => {
    const decided = decideStewardAction(
      {
        id: "lp-test",
        status: "review_interrupted",
        headSha: "abc",
        exportGate: null,
      },
      {
        loopId: "lp-test",
        implementorTaskId: null,
        reviewerTaskId: "task-rev-97",
        updatedAt: new Date().toISOString(),
      },
    );
    assert.equal(decided.kind, "resume_reviewer");
    assert.equal(decided.reviewerTaskId, "task-rev-97");
    assert.match(decided.reason, /review_interrupted|Resume/i);
  });

  test("session reconcile digest includes interrupt hint", () => {
    const row = rowForLoop(
      {
        id: "lp-test",
        title: "t",
        status: "review_interrupted",
        headRef: "lp-test",
        headSha: "abcdef12",
      } as LocalPr,
      {
        loopId: "lp-test",
        implementorTaskId: null,
        reviewerTaskId: "task-r",
        updatedAt: new Date().toISOString(),
      },
    );
    const digest = formatSessionReconcileDigest([row]);
    assert.match(digest, /review_interrupted/);
    assert.match(digest, /task-r/);
    assert.match(digest, /review-resume/);
  });
});
