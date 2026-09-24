import assert from "node:assert/strict";
import { test } from "node:test";
import { exportPartialFailureFromRelease, formatExportPartialFailure } from "./export.js";
import type { ReleaseArchivedLoopResult } from "./worktrees.js";

test("exportPartialFailureFromRelease is null when prune succeeded", () => {
  const released: ReleaseArchivedLoopResult = {
    checkedOutBase: true,
    prunedWorktree: true,
    primaryPath: "/repo",
    reopen: false,
    worktreeLeftoverPath: null,
    pruneError: null,
  };
  assert.equal(
    exportPartialFailureFromRelease("https://github.com/o/r/pull/1", released, "/repo.loops/lp-x"),
    null,
  );
});

test("exportPartialFailureFromRelease names leftover path and prune error (RAD-95)", () => {
  const leftover = "C:/Users/me/pr-genie.loops/lp-deadbeef";
  const released: ReleaseArchivedLoopResult = {
    checkedOutBase: true,
    prunedWorktree: false,
    primaryPath: "C:/Users/me/pr-genie",
    reopen: false,
    worktreeLeftoverPath: leftover,
    pruneError: "directory remained after filesystem remove (git link may already be gone)",
  };
  const partial = exportPartialFailureFromRelease(
    "https://github.com/radiancelux/pr-genie/pull/99",
    released,
    leftover,
  );
  assert.ok(partial);
  assert.equal(partial.kind, "partial_failure");
  assert.equal(partial.prOpened, true);
  assert.equal(partial.url, "https://github.com/radiancelux/pr-genie/pull/99");
  assert.equal(partial.worktreePath, leftover);
  assert.equal(partial.prunedWorktree, false);
  assert.equal(partial.reopen, false);
  assert.match(partial.message, /^PR opened; worktree still at /);
  assert.match(partial.message, /lp-deadbeef/);
  assert.match(partial.message, /directory remained after filesystem remove/);
  assert.equal(formatExportPartialFailure(partial), partial.message);
});

test("exportPartialFailureFromRelease uses reopen reason when sitting on worktree", () => {
  const leftover = "/tmp/pr-genie.loops/lp-aabbccdd";
  const primary = "/tmp/pr-genie";
  const released: ReleaseArchivedLoopResult = {
    checkedOutBase: false,
    prunedWorktree: false,
    primaryPath: primary,
    reopen: true,
    worktreeLeftoverPath: leftover,
    pruneError: "cwd is the loop worktree — reopen primary before prune",
  };
  const partial = exportPartialFailureFromRelease("https://example.com/pr/1", released, leftover);
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
  const released: ReleaseArchivedLoopResult = {
    checkedOutBase: false,
    prunedWorktree: false,
    primaryPath: "/repo",
    reopen: false,
    worktreeLeftoverPath: null,
    pruneError: null,
  };
  const partial = exportPartialFailureFromRelease("https://x/pr/2", released, archived);
  assert.ok(partial);
  assert.equal(partial.worktreePath, archived);
  assert.equal(partial.message, `PR opened; worktree still at ${archived}; prune failed`);
});
