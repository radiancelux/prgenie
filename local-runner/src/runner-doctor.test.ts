import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { formatRunnerDoctorReport, runRunnerDoctor } from "./runner-doctor.js";
import { runInit } from "./init.js";

describe("prgenie doctor", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "prgenie-runner-doc-"));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports node version and runner config after init", async () => {
    const dataDir = path.join(dir, "runner");
    await runInit({ dataDir });
    const report = await runRunnerDoctor({
      ...process.env,
      PRGENIE_RUNNER_DATA_DIR: dataDir,
    });
    const node = report.checks.find((c) => c.id === "node-version");
    assert.ok(node);
    const cfg = report.checks.find((c) => c.id === "runner-config");
    assert.ok(cfg?.ok);
    assert.match(formatRunnerDoctorReport(report), /runner-data-dir/);
  });
});
