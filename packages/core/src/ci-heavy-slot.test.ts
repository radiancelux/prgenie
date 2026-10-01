import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pidAlive } from "./ci-abort.js";
import { acquireHeavyTestSlot, ciHeavySlotDir, heavyTestConcurrency } from "./ci-heavy-slot.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "prgenie-heavy-slot-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@test"], repo);
  git(["config", "user.name", "T"], repo);
  return repo;
}

describe("RAD-134 heavy slot module", () => {
  after(async () => {
    // per-test cleanup
  });

  it("RAD-134: concurrency defaults to 2 and reads PRGENIE_CI_HEAVY_CONCURRENCY", () => {
    assert.equal(heavyTestConcurrency({}), 2);
    assert.equal(heavyTestConcurrency({ PRGENIE_CI_HEAVY_CONCURRENCY: "3" }), 3);
  });

  it("RAD-134: invalid concurrency values fall back to 2 with one warning", () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk, encoding, cb) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return orig(chunk, encoding, cb);
    }) as typeof process.stderr.write;
    try {
      for (const v of ["0", "33", "2.5", "abc"]) {
        assert.equal(heavyTestConcurrency({ PRGENIE_CI_HEAVY_CONCURRENCY: v }), 2);
      }
      assert.equal(
        writes.filter((w) => w.includes("PRGENIE_CI_HEAVY_CONCURRENCY") && w.includes("invalid"))
          .length,
        1,
      );
    } finally {
      process.stderr.write = orig;
    }
  });

  it("RAD-134: acquire takes the lowest free slot file with exclusive create", async () => {
    const repo = await tempRepo();
    try {
      const dir = await ciHeavySlotDir(repo);
      const h = await acquireHeavyTestSlot({
        cwd: repo,
        check: "test:core",
        concurrency: 2,
        timing: { pollMs: 20 },
      });
      assert.ok(existsSync(path.join(dir, "slot-0.json")));
      h.release();
      assert.ok(!existsSync(path.join(dir, "slot-0.json")));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-134: third acquire waits until a slot is released", async () => {
    const repo = await tempRepo();
    try {
      const h1 = await acquireHeavyTestSlot({
        cwd: repo,
        loopId: "lp-aaaaaaaa",
        check: "a",
        concurrency: 2,
        timing: { pollMs: 20 },
      });
      const h2 = await acquireHeavyTestSlot({
        cwd: repo,
        loopId: "lp-bbbbbbbb",
        check: "b",
        concurrency: 2,
        timing: { pollMs: 20 },
      });
      let thirdStarted = false;
      const pending = acquireHeavyTestSlot({
        cwd: repo,
        loopId: "lp-cccccccc",
        check: "c",
        concurrency: 2,
        timing: { pollMs: 20 },
      }).then((h) => {
        thirdStarted = true;
        h.release();
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(thirdStarted, false);
      h1.release();
      await pending;
      assert.equal(thirdStarted, true);
      h2.release();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-134: holder heartbeat refreshes heartbeatAt", async () => {
    const repo = await tempRepo();
    try {
      const dir = await ciHeavySlotDir(repo);
      const h = await acquireHeavyTestSlot({
        cwd: repo,
        check: "test:core",
        concurrency: 2,
        timing: { pollMs: 20, heartbeatMs: 20 },
      });
      const file = path.join(dir, "slot-0.json");
      const first = JSON.parse(readFileSync(file, "utf8")) as { heartbeatAt: string };
      await new Promise((r) => setTimeout(r, 60));
      const second = JSON.parse(readFileSync(file, "utf8")) as { heartbeatAt: string };
      assert.notEqual(first.heartbeatAt, second.heartbeatAt);
      h.release();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-134: release deletes only the holder's own slot file", async () => {
    const repo = await tempRepo();
    try {
      const dir = await ciHeavySlotDir(repo);
      const h1 = await acquireHeavyTestSlot({
        cwd: repo,
        check: "a",
        concurrency: 2,
        timing: { pollMs: 20 },
      });
      const h2 = await acquireHeavyTestSlot({
        cwd: repo,
        check: "b",
        concurrency: 2,
        timing: { pollMs: 20 },
      });
      h1.release();
      assert.ok(!existsSync(path.join(dir, "slot-0.json")));
      assert.ok(existsSync(path.join(dir, "slot-1.json")));
      h2.release();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-134: dead-pid, old-heartbeat and corrupt slots are recovered", async () => {
    const repo = await tempRepo();
    try {
      const dir = await ciHeavySlotDir(repo);
      mkdirSync(dir, { recursive: true });
      const deadPid = 999_999;
      assert.equal(pidAlive(deadPid), false);
      writeFileSync(
        path.join(dir, "slot-0.json"),
        `${JSON.stringify({
          token: "dead",
          pid: deadPid,
          loopId: null,
          check: "x",
          cwd: repo,
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        })}\n`,
      );
      const hDead = await acquireHeavyTestSlot({
        cwd: repo,
        check: "after-dead",
        concurrency: 1,
        timing: { pollMs: 20, staleMs: 90_000 },
      });
      assert.equal(readdirSync(dir).filter((n) => n.startsWith("slot-")).length, 1);
      hDead.release();

      const old = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(
        path.join(dir, "slot-0.json"),
        `${JSON.stringify({
          token: "old",
          pid: process.pid,
          loopId: null,
          check: "y",
          cwd: repo,
          acquiredAt: old,
          heartbeatAt: old,
        })}\n`,
      );
      const hOld = await acquireHeavyTestSlot({
        cwd: repo,
        check: "after-old-hb",
        concurrency: 1,
        timing: { pollMs: 20, staleMs: 90_000 },
      });
      hOld.release();

      const corruptPath = path.join(dir, "slot-0.json");
      writeFileSync(corruptPath, "not-json\n");
      const corruptOld = Date.now() - 120_000;
      utimesSync(corruptPath, corruptOld / 1000, corruptOld / 1000);
      const hCorrupt = await acquireHeavyTestSlot({
        cwd: repo,
        check: "after-corrupt",
        concurrency: 1,
        timing: { pollMs: 20, staleMs: 90_000 },
      });
      assert.equal(readdirSync(dir).filter((n) => n.startsWith("slot-")).length, 1);
      hCorrupt.release();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
