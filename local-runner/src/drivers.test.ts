import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDriver, listBuiltInDriverIds } from "./drivers/built-in.js";
import { AgentRunner } from "./agent.js";
import { createJob } from "./store.js";
import { loadSettings, findDriverEntry } from "./settings.js";

describe("agent drivers", () => {
  it("lists built-in drivers with cursor-agent default id", () => {
    const ids = listBuiltInDriverIds();
    assert.ok(ids.includes("cursor-agent"));
    assert.ok(getAgentDriver("cursor-agent"));
  });

  it("createJob uses settings defaultDriver and job override", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-drv-job-"));
    await import("./settings.js").then(({ saveSettings }) =>
      saveSettings(dataDir, { defaultDriver: "claude-code" }),
    );
    const job = await createJob(
      dataDir,
      { repoPath: "/r", branch: "b", promptFile: "/p", driver: "local-model", dryRun: true },
      { model: "m", dryRun: true, config: { defaultCodeRepoPath: null } },
    );
    assert.equal(job.driverId, "local-model");

    const job2 = await createJob(
      dataDir,
      { repoPath: "/r", branch: "b2", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true, config: { defaultCodeRepoPath: null } },
    );
    assert.equal(job2.driverId, "claude-code");
  });

  it("missing binary fails the job cleanly in dry-run off path", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-drv-miss-"));
    const settings = await loadSettings(dataDir);
    const entry = findDriverEntry(settings, "cursor-agent")!;
    const runner = new AgentRunner();
    await assert.rejects(
      () =>
        runner.run({
          cwd: "/tmp",
          prompt: "hi",
          model: "m",
          logPath: path.join(dataDir, "x.log"),
          dryRun: false,
          driverId: "cursor-agent",
          driverEntry: { ...entry, binary: "__no_such_binary_xyz__" },
        }),
      /binary not found/,
    );
  });

  it("local-model driver config plumbing", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-drv-local-"));
    const settings = await loadSettings(dataDir);
    const entry = findDriverEntry(settings, "local-model")!;
    assert.equal(entry.endpoint?.includes("11434"), true);
    const runner = new AgentRunner();
    const logPath = path.join(dataDir, "run.log");
    const result = await runner.run({
      cwd: "/tmp",
      prompt: "ping",
      model: "llama3",
      logPath,
      dryRun: true,
      driverId: "local-model",
      driverEntry: entry,
    });
    assert.equal(result.code, 0);
  });
});
