import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunnerConfig } from "./config.js";
import { loadSettings } from "./settings.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStageModelsForJob } from "./job-models.js";
import { BUILTIN_FIX_MODEL } from "./runner-policy.js";

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

describe("stage models", () => {
  it("defaults build/review from env and fix to auto", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-"));
    const settings = await loadSettings(dataDir);
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      settings,
      { repoPath: "/r", branch: "b", promptFile: "/p" },
      "cursor-agent",
    );
    assert.equal(resolved.build, "composer-2.5");
    assert.equal(resolved.review, "composer-2.5");
    assert.equal(resolved.fix, BUILTIN_FIX_MODEL);
  });

  it("legacy single model applies to all stages", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-legacy-"));
    const settings = await loadSettings(dataDir);
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      settings,
      { repoPath: "/r", branch: "b", promptFile: "/p", model: "gpt-test" },
      "cursor-agent",
    );
    assert.equal(resolved.build, "gpt-test");
    assert.equal(resolved.review, "gpt-test");
    assert.equal(resolved.fix, "gpt-test");
  });
});
