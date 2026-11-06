import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { loadSettings, maskSecret, saveSettings, toPublicSettings } from "./settings.js";
import { notifySettingsFile } from "./paths.js";

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: "env@example.com",
    resendApiKey: "re_key",
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

describe("runner settings", () => {
  it("defaults when no files exist", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-set-"));
    const s = await loadSettings(dataDir);
    assert.equal(s.configured, false);
    assert.equal(s.defaultDriver, "cursor-agent");
    assert.equal(s.notify.enabled, false);
  });

  it("migrates legacy notify-settings.json", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-set-mig-"));
    await writeFile(
      notifySettingsFile(dataDir),
      JSON.stringify({ enabled: true, recipient: "a@b.c" }),
      "utf8",
    );
    const s = await loadSettings(dataDir);
    assert.equal(s.configured, true);
    assert.equal(s.notify.enabled, true);
    assert.equal(s.notify.recipient, "a@b.c");
    const again = await loadSettings(dataDir);
    assert.equal(again.notify.recipient, "a@b.c");
  });

  it("masks secrets on public read", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-set-mask-"));
    await saveSettings(dataDir, {
      drivers: [
        {
          id: "local-model",
          kind: "local-model",
          apiKey: "sk-secret-key-1234",
        },
      ],
    });
    const s = await loadSettings(dataDir);
    const pub = toPublicSettings(testConfig(dataDir), s);
    const drv = pub.drivers.find((d) => d.id === "local-model");
    assert.equal(drv?.hasApiKey, true);
    assert.match(String(drv?.apiKeyMasked), /1234$/);
    assert.equal("apiKey" in (drv ?? {}), false);
  });

  it("persists default driver and model", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-set-save-"));
    await saveSettings(dataDir, {
      configured: true,
      defaultModel: "gpt-test",
      defaultDriver: "claude-code",
    });
    const s = await loadSettings(dataDir);
    assert.equal(s.defaultModel, "gpt-test");
    assert.equal(s.defaultDriver, "claude-code");
  });

  it("maskSecret short values", () => {
    assert.equal(maskSecret("ab"), "••••");
    assert.equal(maskSecret(null), null);
  });
});
