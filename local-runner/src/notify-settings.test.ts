import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import {
  loadNotifySettings,
  resolveNotifyRecipient,
  saveNotifySettings,
  toPublicNotifySettings,
} from "./notify-settings.js";

function testConfig(dataDir: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
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
    ...overrides,
  };
}

describe("notify settings", () => {
  it("defaults when file missing", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-notify-"));
    const s = await loadNotifySettings(dataDir);
    assert.equal(s.enabled, false);
    assert.equal(s.recipient, null);
  });

  it("persists enabled and recipient", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-notify-"));
    await saveNotifySettings(dataDir, { enabled: true, recipient: "you@example.com" });
    const s = await loadNotifySettings(dataDir);
    assert.equal(s.enabled, true);
    assert.equal(s.recipient, "you@example.com");
  });

  it("resolveNotifyRecipient respects enabled and env fallback", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-notify-"));
    const config = testConfig(dataDir);
    assert.equal(resolveNotifyRecipient(config, { enabled: false, recipient: "a@b.c" }), null);
    assert.equal(
      resolveNotifyRecipient(config, { enabled: true, recipient: null }),
      "env@example.com",
    );
    assert.equal(
      resolveNotifyRecipient(config, { enabled: true, recipient: "dash@example.com" }),
      "dash@example.com",
    );
    assert.equal(
      resolveNotifyRecipient(testConfig(dataDir, { resendApiKey: null }), {
        enabled: true,
        recipient: null,
      }),
      null,
    );
  });

  it("toPublicNotifySettings omits secrets", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-notify-"));
    const pub = toPublicNotifySettings(testConfig(dataDir), { enabled: true, recipient: null });
    assert.equal(pub.envFallbackRecipient, "env@example.com");
    assert.equal(pub.resendConfigured, true);
    assert.equal("resendApiKey" in pub, false);
  });
});
