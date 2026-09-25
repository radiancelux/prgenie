import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, it } from "node:test";
import { createTempGitRepo } from "./test-git-fixture.js";
import {
  acquireCiLock,
  ciAbortFile,
  pidAlive,
  readCiAbortSeq,
  requestCiAbort,
  watchCiAbort,
} from "./ci-abort.js";
import { isAbortError } from "./progress.js";

async function initRepo(): Promise<string> {
  return createTempGitRepo({ prefix: "prgenie-ci-abort-" });
}

describe("ci-abort token", () => {
  it("bumps seq and watchCiAbort aborts a later generation", async () => {
    const repo = await initRepo();
    try {
      assert.ok(pidAlive(process.pid));
      assert.equal(readCiAbortSeq(repo, "lp-a"), 0);
      const ac = new AbortController();
      const stop = watchCiAbort(repo, "lp-a", ac);
      assert.ok(ciAbortFile(repo, "lp-a").includes("ci-abort"));
      requestCiAbort(repo, "lp-a");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(ac.signal.aborted, true);
      assert.equal(readCiAbortSeq(repo, "lp-a"), 1);
      stop();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("a new watch after abort does not fire until the next bump", async () => {
    const repo = await initRepo();
    try {
      requestCiAbort(repo, "lp-b");
      const ac = new AbortController();
      const stop = watchCiAbort(repo, "lp-b", ac);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(ac.signal.aborted, false);
      requestCiAbort(repo, "lp-b");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(ac.signal.aborted, true);
      stop();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("acquireCiLock waits on a live peer then returns peerDone when the lock vanishes", async () => {
    const repo = await initRepo();
    try {
      const owned = await acquireCiLock(repo, "lp-c", "abc");
      assert.equal(owned.peerDone, false);
      const waiter = acquireCiLock(repo, "lp-c", "abc");
      await new Promise((resolve) => setTimeout(resolve, 80));
      owned.release();
      const joined = await waiter;
      assert.equal(joined.peerDone, true);
      joined.release();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("acquireCiLock aborts while waiting on a live peer lock", async () => {
    const repo = await initRepo();
    try {
      const owned = await acquireCiLock(repo, "lp-d", "def");
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 80);
      await assert.rejects(
        () => acquireCiLock(repo, "lp-d", "def", ac.signal),
        (err: unknown) => isAbortError(err),
      );
      owned.release();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
