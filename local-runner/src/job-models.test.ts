import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunnerConfig } from "./config.js";
import { loadSettings, saveSettings } from "./settings.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStageModelsForJob } from "./job-models.js";
import { BUILTIN_FIX_MODEL } from "./runner-policy.js";
import { runnerSettingsFile } from "./paths.js";
import { ValidationError } from "./validation-error.js";

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

  for (const driver of ["claude-code", "local-model"]) {
    it(`${driver} fix stage falls back to the build model instead of auto`, async () => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-noauto-"));
      const settings = await loadSettings(dataDir);
      const resolved = resolveStageModelsForJob(
        testConfig(dataDir),
        settings,
        { repoPath: "/r", branch: "b", promptFile: "/p" },
        driver,
      );
      assert.notEqual(resolved.fix, "auto");
      assert.equal(resolved.fix, resolved.build);
    });
  }

  it("rejects an explicit auto fix model for a driver without auto", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-noauto-explicit-"));
    const settings = await loadSettings(dataDir);
    assert.throws(
      () =>
        resolveStageModelsForJob(
          testConfig(dataDir),
          settings,
          { repoPath: "/r", branch: "b", promptFile: "/p", stageModels: { fix: "auto" } },
          "claude-code",
        ),
      ValidationError,
    );
  });

  it("defaultModel edits after a legacy-settings upgrade reach new jobs", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-upgrade-"));
    await writeFile(
      runnerSettingsFile(dataDir),
      JSON.stringify({ version: 1, configured: true, defaultModel: "old-model" }),
      "utf8",
    );
    await saveSettings(dataDir, { notify: { enabled: false } });
    await saveSettings(dataDir, { defaultModel: "new-model" });
    const settings = await loadSettings(dataDir);
    assert.equal(settings.stageModels.build, null);
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      settings,
      { repoPath: "/r", branch: "b", promptFile: "/p" },
      "cursor-agent",
    );
    assert.equal(resolved.build, "new-model");
    assert.equal(resolved.review, "new-model");
  });
});
