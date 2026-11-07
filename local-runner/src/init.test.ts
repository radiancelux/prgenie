import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runnerTokenFile } from "./config.js";
import { formatInitReport, runInit } from "./init.js";

describe("prgenie init", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "prgenie-init-"));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("creates data dir and token file", async () => {
    const dataDir = path.join(dir, "data");
    const result = await runInit({ dataDir });
    assert.equal(result.createdToken, true);
    const token = (await readFile(runnerTokenFile(dataDir), "utf8")).trim();
    assert.ok(token.length >= 16);
    assert.match(formatInitReport(result), /prgenie doctor/);
  });

  it("does not rotate token without --force-token", async () => {
    const dataDir = path.join(dir, "keep");
    const first = await runInit({ dataDir });
    const token = await readFile(first.tokenFile, "utf8");
    const second = await runInit({ dataDir });
    assert.equal(second.createdToken, false);
    assert.equal(await readFile(first.tokenFile, "utf8"), token);
  });
});
