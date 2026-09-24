import assert from "node:assert/strict";
import { test } from "node:test";
import { exportPartialFailureFromRelease, formatExportPartialFailure } from "./export.js";
import type { FinalizeArchivedLoopResult } from "./worktrees.js";

function released(
  patch: Partial<FinalizeArchivedLoopResult> &
    Pick<FinalizeArchivedLoopResult, "prunedWorktree" | "deletedBranch">,
): FinalizeArchivedLoopResult {
  return {
    checkedOutBase: true,
    primaryPath: "/repo",
    reopen: false,
    worktreeLeftoverPath: null,
    pruneError: null,
    branch: "lp-x",
    branchError: null,
    ...patch,
  };
}

test("exportPartialFailureFromRelease is null when prune and branch delete succeeded", () => {
  assert.equal(
    exportPartialFailureFromRelease(
      "https://github.com/o/r/pull/1",
      released({ prunedWorktree: true, deletedBranch: true }),
      "/repo.loops/lp-x",
    ),
    null,
  );
});

test("exportPartialFailureFromRelease names leftover path and prune error (RAD-95)", () => {
  const leftover = "C:/Users/me/pr-genie.loops/lp-deadbeef";
  const partial = exportPartialFailureFromRelease(
    "https://github.com/radiancelux/pr-genie/pull/99",
    released({
      prunedWorktree: false,
      deletedBranch: true,
      primaryPath: "C:/Users/me/pr-genie",
      worktreeLeftoverPath: leftover,
      pruneError: "directory remained after filesystem remove (git link may already be gone)",
    }),
    leftover,
  );
  assert.ok(partial);
  assert.equal(partial.kind, "partial_failure");
  assert.equal(partial.prOpened, true);
  assert.equal(partial.url, "https://github.com/radiancelux/pr-genie/pull/99");
  assert.equal(partial.worktreePath, leftover);
  assert.equal(partial.prunedWorktree, false);
  assert.equal(partial.deletedBranch, true);
  assert.equal(partial.reopen, false);
  assert.match(partial.message, /^PR opened; worktree still at /);
  assert.match(partial.message, /lp-deadbeef/);
  assert.match(partial.message, /directory remained after filesystem remove/);
  assert.equal(formatExportPartialFailure(partial), partial.message);
});

test("exportPartialFailureFromRelease uses reopen reason when sitting on worktree", () => {
  const leftover = "/tmp/pr-genie.loops/lp-aabbccdd";
  const primary = "/tmp/pr-genie";
  const partial = exportPartialFailureFromRelease(
    "https://example.com/pr/1",
    released({
      checkedOutBase: false,
      prunedWorktree: false,
      deletedBranch: true,
      primaryPath: primary,
      reopen: true,
      worktreeLeftoverPath: leftover,
      pruneError: "cwd is the loop worktree — reopen primary before prune",
    }),
    leftover,
  );
  assert.ok(partial);
  assert.equal(partial.prOpened, true);
  assert.equal(partial.reopen, true);
  assert.equal(partial.worktreePath, leftover);
  assert.match(
    partial.message,
    new RegExp(
      `PR opened; worktree still at ${leftover.replace(/\\/g, "\\\\")}; reopen primary at`,
    ),
  );
  assert.match(partial.message, /reopen primary at \/tmp\/pr-genie then prune/);
  // Reopen reason wins over pruneError in the message.
  assert.doesNotMatch(partial.message, /cwd is the loop worktree/);
});

test("exportPartialFailureFromRelease falls back to archived worktree path", () => {
  const archived = "/repo.loops/lp-fallback";
  const partial = exportPartialFailureFromRelease(
    "https://x/pr/2",
    released({
      checkedOutBase: false,
      prunedWorktree: false,
      deletedBranch: true,
      worktreeLeftoverPath: null,
      pruneError: null,
    }),
    archived,
  );
  assert.ok(partial);
  assert.equal(partial.worktreePath, archived);
  assert.equal(partial.message, `PR opened; worktree still at ${archived}; prune failed`);
});

test("exportPartialFailureFromRelease reports failed local branch delete (RAD-130)", () => {
  const partial = exportPartialFailureFromRelease(
    "https://github.com/o/r/pull/7",
    released({
      prunedWorktree: true,
      deletedBranch: false,
      branch: "lp-41f1e203",
      branchError: "branch lp-41f1e203 still checked out at /repo.loops/lp-41f1e203",
    }),
    "/repo.loops/lp-41f1e203",
  );
  assert.ok(partial);
  assert.equal(partial.prunedWorktree, true);
  assert.equal(partial.deletedBranch, false);
  assert.equal(partial.branch, "lp-41f1e203");
  assert.match(partial.message, /PR opened;/);
  assert.match(partial.message, /local branch lp-41f1e203 not deleted/);
  assert.match(partial.message, /still checked out/);
  assert.doesNotMatch(partial.message, /worktree still at/);
});

test("exportPartialFailureFromRelease combines prune and branch failures", () => {
  const leftover = "/repo.loops/lp-both";
  const partial = exportPartialFailureFromRelease(
    "https://x/pr/3",
    released({
      prunedWorktree: false,
      deletedBranch: false,
      worktreeLeftoverPath: leftover,
      pruneError: null,
      branch: "lp-both",
      branchError: null,
    }),
    leftover,
  );
  assert.ok(partial);
  assert.match(partial.message, /worktree still at/);
  assert.match(partial.message, /prune failed/);
  assert.match(partial.message, /local branch lp-both not deleted \(delete failed\)/);
});
