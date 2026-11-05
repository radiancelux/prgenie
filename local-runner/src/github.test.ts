import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findVerdictInCommentsSince,
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

describe("isBranchSyncedWithOrigin", () => {
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
    const result = await isBranchSyncedWithOrigin("/wt", "feat/x", gitImpl);
    assert.deepEqual(result, { ok: true });
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
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await isBranchSyncedWithOrigin("/wt", "feat/x", gitImpl);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /does not match origin/);
    }
  });
});
