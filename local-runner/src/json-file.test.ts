import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readUtf8WithRetry, setJsonFileTestHooks, writeJsonFile } from "./json-file.js";

let dir = "";

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("json-file", () => {
  it("rename retries on EPERM then succeeds", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lr-json-"));
    const file = path.join(dir, "job.json");
    await writeFile(file, "{}\n", "utf8");
    let attempts = 0;
    setJsonFileTestHooks({
      delay: async () => undefined,
      rename: async (from, to) => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        await rename(from, to);
      },
    });
    try {
      await writeJsonFile(file, { ok: true });
    } finally {
      setJsonFileTestHooks(undefined);
    }
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
  });

  it("readUtf8WithRetry tolerates torn JSON during write", async () => {
    const file = path.join(dir, "torn.json");
    let reads = 0;
    setJsonFileTestHooks({
      delay: async () => undefined,
      readFile: async () => {
        reads += 1;
        if (reads < 2) return '{"id":';
        return '{"id":"x"}\n';
      },
    });
    try {
      const raw = await readUtf8WithRetry(file);
      assert.equal(raw, '{"id":"x"}\n');
      assert.equal(reads, 2);
    } finally {
      setJsonFileTestHooks(undefined);
    }
  });

  it("persistent rename failure keeps temp file", async () => {
    const file = path.join(dir, "persist.json");
    await writeFile(file, '{"a":1}\n', "utf8");
    let tmp = "";
    setJsonFileTestHooks({
      delay: async () => undefined,
      rename: async (from) => {
        tmp = from;
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      },
    });
    try {
      await assert.rejects(() => writeJsonFile(file, { a: 2 }), /temp kept for recovery/);
    } finally {
      setJsonFileTestHooks(undefined);
    }
    assert.match(tmp, /\.tmp$/);
    await access(tmp);
    assert.equal(await readFile(file, "utf8"), '{"a":1}\n');
  });
});
