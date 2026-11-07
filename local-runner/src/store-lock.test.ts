import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { acquireStoreLock, withStoreLock } from "./store-lock.js";

describe("store lock", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "prgenie-lock-"));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("serializes concurrent withStoreLock calls in-process", async () => {
    const order: number[] = [];
    await Promise.all([
      withStoreLock(dir, async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 30));
        order.push(2);
      }),
      withStoreLock(dir, async () => {
        order.push(3);
      }),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("release clears lock file", async () => {
    const handle = await acquireStoreLock(dir);
    handle.release();
    const again = await acquireStoreLock(dir);
    again.release();
  });
});
