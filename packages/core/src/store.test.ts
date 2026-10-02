import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { STALE_LOCK_MS, fileLockIsStale } from "./ci-abort.js";
import { firstJsonObject, parseJsonObject, withFileLock, writeJsonFile } from "./store.js";

const DEAD_PID = 987_654_321;

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-store-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("store", { concurrency: 1 }, () => {
  test("parseJsonObject recovers leftover bytes after a shorter overwrite", () => {
    const body = { id: "lp-test", status: "approved" };
    const raw = `${JSON.stringify(body, null, 2)}\n7.247Z"\n}`;
    assert.equal(firstJsonObject(raw), JSON.stringify(body, null, 2));
    const parsed = parseJsonObject<typeof body>(raw);
    assert.equal(parsed.id, "lp-test");
    assert.equal(parsed.status, "approved");
  });

  test("withFileLock rethrows fn errors without retrying the lock loop", async () => {
    const file = path.join(dir, "lock-target.json");
    await writeFile(file, "{}\n", "utf8");
    const started = Date.now();
    await assert.rejects(
      () =>
        withFileLock(file, async () => {
          throw new Error("HEAD moved since Review requested");
        }),
      /HEAD moved/,
    );
    assert.ok(Date.now() - started < 2000, "expected immediate rethrow, not lock backoff");
  });

  test("withFileLock writes pid hostname and acquiredAt (172-R1)", async () => {
    const file = path.join(dir, "meta-target.json");
    await writeFile(file, "{}\n", "utf8");
    await withFileLock(file, async () => {
      const raw = await readFile(`${file}.lock`, "utf8");
      const meta = JSON.parse(raw.trim()) as {
        pid: number;
        hostname: string;
        acquiredAt: string;
      };
      assert.equal(meta.pid, process.pid);
      assert.equal(meta.hostname, os.hostname());
      assert.ok(Date.parse(meta.acquiredAt));
    });
  });

  test("withFileLock steals a lock held by a dead pid (172-R2)", async () => {
    const file = path.join(dir, "dead-pid-target.json");
    const lock = `${file}.lock`;
    await writeFile(file, "{}\n", "utf8");
    await writeFile(
      lock,
      `${JSON.stringify({
        pid: DEAD_PID,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    let got = false;
    await withFileLock(file, async () => {
      got = true;
    });
    assert.equal(got, true);
  });

  test("withFileLock does not steal a live local lock under max hold time (172-R2)", async () => {
    const file = path.join(dir, "live-lock-target.json");
    const lock = `${file}.lock`;
    await writeFile(file, "{}\n", "utf8");
    await writeFile(
      lock,
      `${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    let got = false;
    const attempt = withFileLock(file, async () => {
      got = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(got, false);
    await unlink(lock);
    await attempt;
    assert.equal(got, true);
  });

  test("fileLockIsStale: remote hostname stolen only by age (172-R2)", () => {
    const now = Date.now();
    const recent = {
      pid: process.pid,
      hostname: "remote-host.example",
      acquiredAt: new Date(now - 1000).toISOString(),
    };
    assert.equal(fileLockIsStale(recent, now, now), false);
    const aged = {
      ...recent,
      acquiredAt: new Date(now - STALE_LOCK_MS - 1).toISOString(),
    };
    assert.equal(fileLockIsStale(aged, now, now), true);
  });

  test("concurrent stale-lock stealers never overlap inside fn", async () => {
    const file = path.join(dir, "concurrent-steal-target.json");
    const lock = `${file}.lock`;
    await writeFile(file, "{}\n", "utf8");
    const deadRecord = {
      pid: DEAD_PID,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    let maxInside = 0;
    for (let trial = 0; trial < 40; trial += 1) {
      await writeFile(lock, `${JSON.stringify(deadRecord)}\n`, "utf8");
      let inside = 0;
      await Promise.all(
        Array.from({ length: 4 }, () =>
          withFileLock(file, async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inside -= 1;
          }),
        ),
      );
    }
    assert.equal(maxInside, 1, `expected no overlapping callbacks, saw ${maxInside}`);
  });

  test("live age-stale holder still inside fn is not overlapped", async () => {
    const file = path.join(dir, "live-age-holder.json");
    const lock = `${file}.lock`;
    await writeFile(file, "{}\n", "utf8");
    let inside = 0;
    let maxInside = 0;
    let releaseFirst: () => void = () => undefined;
    const stayInside = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstInside: () => void = () => undefined;
    const firstHolding = new Promise<void>((resolve) => {
      markFirstInside = resolve;
    });

    const first = withFileLock(file, async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      const meta = JSON.parse((await readFile(lock, "utf8")).trim()) as {
        pid: number;
        hostname: string;
        acquiredAt: string;
      };
      assert.equal(meta.pid, process.pid);
      meta.acquiredAt = new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString();
      await writeFile(lock, `${JSON.stringify(meta)}\n`, "utf8");
      markFirstInside();
      await stayInside;
      inside -= 1;
    });

    await firstHolding;
    let secondRan = false;
    const second = withFileLock(file, async () => {
      secondRan = true;
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      inside -= 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(inside, 1);
    assert.equal(maxInside, 1, "age steal admitted a second holder while fn was still running");
    assert.equal(secondRan, false);
    releaseFirst();
    await first;
    await second;
    assert.equal(maxInside, 1);
    assert.equal(secondRan, true);
  });

  test("withFileLock steals legacy empty lock past max age (172-R2)", async () => {
    const file = path.join(dir, "legacy-target.json");
    const lock = `${file}.lock`;
    await writeFile(file, "{}\n", "utf8");
    await writeFile(lock, "", "utf8");
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    await utimes(lock, old, old);
    let got = false;
    await withFileLock(file, async () => {
      got = true;
    });
    assert.equal(got, true);
  });

  test("writeJsonFile truncates leftover bytes from a previous longer file", async () => {
    const file = path.join(dir, "pr.json");
    await writeFile(
      file,
      `${JSON.stringify({ status: "changes_requested", extra: "pad-pad-pad" }, null, 2)}\n`,
      "utf8",
    );
    await writeJsonFile(file, { status: "approved" });
    const raw = await readFile(file, "utf8");
    JSON.parse(raw);
    assert.equal(raw.includes("changes_requested"), false);
    assert.equal(raw.includes("pad-pad-pad"), false);
  });
});
