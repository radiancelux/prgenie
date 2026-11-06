import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocsSettings } from "./docs-settings.js";
import { loadSettings, saveSettings } from "./settings.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

describe("docs settings", () => {
  it("round-trips repo presets and default per job type", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-docs-set-"));
    await saveSettings(dataDir, {
      presets: {
        repos: [{ id: "a", name: "A", slug: "org/a", repoPath: "/tmp/a" }],
      },
      jobTypes: {
        defaultPresetId: { code: "a", docs: "a" },
        docChecks: { enabled: true, failHard: true },
      },
    });
    const s = await loadSettings(dataDir);
    const parsed = parseDocsSettings(s);
    assert.equal(parsed.repoPresets.length, 1);
    assert.equal(parsed.defaultPresetId.docs, "a");
    assert.equal(parsed.docChecks.failHard, true);
  });

  it("does not hardcode example business repo in defaults", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-docs-grep-"));
    const s = await loadSettings(dataDir);
    const parsed = parseDocsSettings(s);
    const blob = JSON.stringify({ s, parsed });
    assert.doesNotMatch(blob, /cc-consulting-nv\/img-business/i);
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const settingsSrc = await readFile(path.join(srcDir, "settings.ts"), "utf8");
    const jobTargetSrc = await readFile(path.join(srcDir, "job-target.ts"), "utf8");
    assert.doesNotMatch(settingsSrc, /cc-consulting-nv\/img-business/i);
    assert.doesNotMatch(jobTargetSrc, /cc-consulting-nv\/img-business/i);
  });
});
