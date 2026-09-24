import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatCiSkipBody,
  isReadyCiSatisfied,
  parseCiSkipReason,
  readyCiBlockMessage,
  readyCiFromSkipReason,
  tipScopedCiSkipReason,
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

  test("unscoped CI skipped comment does not satisfy a new tip", () => {
    const pr = {
      id: "lp-x",
      headSha: "tip-b",
      readyCi: readyCiFromSkipReason("tip-a", "old tip"),
      comments: [
        {
          id: "c1",
          body: "CI skipped: no toolchain",
          createdAt: new Date().toISOString(),
          author: "agent",
          role: "agent",
          status: "resolved",
          // no forSha — historical / unscoped
        },
      ],
    } as unknown as LocalPr;
    assert.equal(isReadyCiSatisfied(pr, "tip-b"), false);
    assert.equal(tipScopedCiSkipReason(pr, "tip-b"), null);
  });

  test("tip-scoped CI skipped comment is found only for matching forSha", () => {
    const pr = {
      id: "lp-x",
      headSha: "tip-a",
      readyCi: null,
      comments: [
        {
          id: "c1",
          body: "CI skipped: no toolchain",
          createdAt: new Date().toISOString(),
          author: "agent",
          role: "agent",
          status: "resolved",
          forSha: "tip-a",
        },
      ],
    } as unknown as LocalPr;
    // isReadyCiSatisfied requires readyCi — comments alone never pass.
    assert.equal(isReadyCiSatisfied(pr, "tip-a"), false);
    assert.equal(tipScopedCiSkipReason(pr, "tip-a"), "no toolchain");
    assert.equal(tipScopedCiSkipReason(pr, "tip-b"), null);
  });

  test("skip on tip A then HEAD tip B is not satisfied", () => {
    const pr = {
      id: "lp-x",
      headSha: "bbbbbbbb",
      readyCi: readyCiFromSkipReason("aaaaaaaa", "toolchain"),
      comments: [
        {
          id: "c1",
          body: "CI skipped: toolchain",
          createdAt: new Date().toISOString(),
          author: "agent",
          role: "agent",
          status: "resolved",
          forSha: "aaaaaaaa",
        },
      ],
    } as unknown as LocalPr;
    assert.equal(isReadyCiSatisfied(pr), false);
    assert.match(readyCiBlockMessage(pr), /Ready blocked \(RAD-97\)/);
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
