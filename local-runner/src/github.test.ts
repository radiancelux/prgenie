import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findVerdictInCommentsSince,
  findVerdictInReviewsSince,
  isBranchSyncedWithOrigin,
  parseVerdictFromText,
  type GitFn,
} from "./github.js";

describe("parseVerdictFromText", () => {
  it("finds APPROVE on last verdict line", () => {
    assert.equal(parseVerdictFromText("Looks good.\n\nVERDICT: APPROVE\n"), "APPROVE");
  });

  it("finds CHANGES", () => {
    assert.equal(parseVerdictFromText("Please fix tests.\nVERDICT: CHANGES"), "CHANGES");
  });

  it("returns null when missing", () => {
    assert.equal(parseVerdictFromText("no verdict here"), null);
  });
});

describe("findVerdictInCommentsSince", () => {
  it("ignores verdicts from prior review rounds by comment id", () => {
    const comments = [
      { id: 10, body: "Old round\nVERDICT: APPROVE", created_at: "2026-01-01T10:00:00Z" },
      { id: 11, body: "This round\nVERDICT: CHANGES", created_at: "2026-01-01T12:00:00Z" },
    ];
    assert.equal(
      findVerdictInCommentsSince(comments, {
        sinceIso: "2026-01-01T11:00:00Z",
        afterCommentId: 10,
      }),
      "CHANGES",
    );
  });

  it("returns null when only stale verdict exists", () => {
    const comments = [{ id: 5, body: "VERDICT: APPROVE", created_at: "2026-01-01T10:00:00Z" }];
    assert.equal(
      findVerdictInCommentsSince(comments, {
        sinceIso: "2026-01-01T11:00:00Z",
        afterCommentId: 5,
      }),
      null,
    );
  });

  it("accepts verdict slightly before local round start when using timestamps", () => {
    const comments = [{ body: "VERDICT: CHANGES", created_at: "2026-01-01T11:59:55Z" }];
    assert.equal(
      findVerdictInCommentsSince(comments, { sinceIso: "2026-01-01T12:00:00Z" }),
      "CHANGES",
    );
  });

  it("rejects verdicts from previous rounds when using timestamps only", () => {
    const comments = [
      { body: "Prior round\nVERDICT: APPROVE", created_at: "2026-01-01T10:00:00Z" },
      { body: "This round\nVERDICT: CHANGES", created_at: "2026-01-01T12:00:00Z" },
    ];
    assert.equal(
      findVerdictInCommentsSince(comments, { sinceIso: "2026-01-01T11:00:00Z" }),
      "CHANGES",
    );
    assert.equal(findVerdictInCommentsSince(comments, { sinceIso: "2026-01-01T12:30:00Z" }), null);
  });
});

describe("findVerdictInReviewsSince", () => {
  it("ignores reviews from prior rounds by review id", () => {
    const reviews = [
      {
        id: 100,
        body: "Old\nVERDICT: APPROVE",
        submitted_at: "2026-01-01T10:00:00Z",
      },
      {
        id: 101,
        body: "This round via gh pr review --comment\nVERDICT: APPROVE",
        submitted_at: "2026-01-01T12:00:00Z",
      },
    ];
    assert.equal(
      findVerdictInReviewsSince(reviews, {
        sinceIso: "2026-01-01T11:00:00Z",
        afterReviewId: 100,
      }),
      "APPROVE",
    );
    assert.equal(
      findVerdictInReviewsSince(reviews, {
        sinceIso: "2026-01-01T11:00:00Z",
        afterReviewId: 101,
      }),
      null,
    );
  });
});

describe("verdict source priority", () => {
  it("issue-comment wins when both comment and review exist in round", () => {
    const scope = {
      sinceIso: "2026-01-01T11:00:00Z",
      afterCommentId: 10,
      afterReviewId: 100,
    };
    const comments = [
      { id: 11, body: "Issue comment\nVERDICT: CHANGES", created_at: "2026-01-01T12:00:00Z" },
    ];
    const reviews = [
      {
        id: 101,
        body: "Review body\nVERDICT: APPROVE",
        submitted_at: "2026-01-01T12:01:00Z",
      },
    ];
    const fromComments = findVerdictInCommentsSince(comments, scope);
    assert.equal(fromComments, "CHANGES");
    assert.equal(fromComments ?? findVerdictInReviewsSince(reviews, scope), "CHANGES");
  });

  it("uses review-body verdict when comments lack one in round", () => {
    const scope = {
      sinceIso: "2026-01-01T11:00:00Z",
      afterCommentId: 10,
      afterReviewId: 100,
    };
    const comments = [
      { id: 11, body: "Feedback without verdict line", created_at: "2026-01-01T12:00:00Z" },
    ];
    const reviews = [
      {
        id: 101,
        body: "Summary\nVERDICT: APPROVE",
        submitted_at: "2026-01-01T12:00:00Z",
      },
    ];
    assert.equal(findVerdictInCommentsSince(comments, scope), null);
    assert.equal(findVerdictInReviewsSince(reviews, scope), "APPROVE");
  });
});

describe("isBranchSyncedWithOrigin", () => {
  let wt = "";

  beforeEach(async () => {
    wt = await mkdtemp(path.join(os.tmpdir(), "lr-sync-wt-"));
    await mkdir(wt, { recursive: true });
  });

  it("passes when local HEAD matches origin", async () => {
    const gitImpl: GitFn = async (_cwd, args) => {
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/feat/x") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const result = await isBranchSyncedWithOrigin(wt, "feat/x", gitImpl);
    assert.deepEqual(result, { ok: true });
  });

  it("reports missing worktree cwd before spawning git", async () => {
    const gitImpl: GitFn = async () => {
      return { code: 1, stdout: "", stderr: "should not run" };
    };
    const result = await isBranchSyncedWithOrigin("/no/such/worktree", "feat/x", gitImpl);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /worktree directory is missing/i);
      assert.match(result.reason, /ENOENT/i);
    }
  });

  it("explains diverged history after a rebase", async () => {
    const gitImpl: GitFn = async (_cwd, args) => {
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "local\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/feat/x") {
        return { code: 0, stdout: "remote\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await isBranchSyncedWithOrigin(wt, "feat/x", gitImpl);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /diverged|rebase|force-push/i);
      assert.equal(result.mismatch, "diverged");
    }
  });

  it("fails when local is ahead of origin", async () => {
    const gitImpl: GitFn = async (_cwd, args) => {
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: "local\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/feat/x") {
        return { code: 0, stdout: "remote\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === "remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await isBranchSyncedWithOrigin(wt, "feat/x", gitImpl);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unpushed commits|ahead of origin/i);
      assert.equal(result.mismatch, "ahead");
    }
  });
});
