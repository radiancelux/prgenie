import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { createJob, listJobs, loadJob } from "./store.js";

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

const createDefaults = (dataDir: string) => ({
  model: "composer-2.5",
  dryRun: true,
  config: testConfig(dataDir),
});

describe("job store", () => {
  it("persists jobs across reload", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-store-"));
    const job = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: "feat/x",
        promptFile: "/tmp/prompt.md",
        maxRounds: 2,
        dryRun: true,
      },
      { model: "composer-2.5", dryRun: false, config: testConfig(dataDir) },
    );
    assert.equal(job.stage, "building");
    const again = await loadJob(dataDir, job.id);
    assert.ok(again);
    assert.equal(again.input.branch, "feat/x");
    const all = await listJobs(dataDir);
    assert.equal(all.length, 1);
  });

  it("infers issue id from branch name", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-store-"));
    const job = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: "feat/issue-320-verdict-resend",
        promptFile: "/tmp/prompt.md",
        dryRun: true,
      },
      createDefaults(dataDir),
    );
    assert.equal(job.linearIssue, "ISSUE-320");
    assert.equal(job.ticketUrl, null);
    assert.equal(job.title, "feat/issue-320-verdict-resend");
  });

  it("stores explicit title and derives from linear slug", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-store-"));
    const explicit = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: "feat/x",
        promptFile: "/tmp/prompt.md",
        title: "My agent",
        dryRun: true,
      },
      createDefaults(dataDir),
    );
    assert.equal(explicit.title, "My agent");

    const dataDir2 = await mkdtemp(path.join(os.tmpdir(), "lr-store-"));
    const fromSlug = await createJob(
      dataDir2,
      {
        repoPath: "/tmp/repo",
        branch: "feat/x",
        promptFile: "/tmp/prompt.md",
        ticketUrl: "https://example.com/issue/ISSUE-327/dashboard-script-parse",
        dryRun: true,
      },
      createDefaults(dataDir2),
    );
    assert.equal(fromSlug.title, "dashboard script parse");
  });

  it("docs job uses setup default repo preset over code default", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-store-docs-"));
    const { saveSettings } = await import("./settings.js");
    await saveSettings(dataDir, {
      presets: {
        repos: [
          {
            id: "biz",
            name: "Business docs",
            repoPath: "/data/business-repo",
            slug: "example-org/example-business",
          },
        ],
      },
      jobTypes: {
        defaultPresetId: { code: null, docs: "biz" },
      },
    });
    const job = await createJob(
      dataDir,
      {
        branch: "docs/policy-update",
        jobType: "docs",
        docsTemplate: "policy",
        dryRun: true,
      },
      createDefaults(dataDir),
    );
    assert.equal(job.input.repoPath, "/data/business-repo");
    assert.equal(job.input.jobType, "docs");
    assert.equal(job.repoSlug, "example-org/example-business");
  });

  it("per-job repoPath override wins over docs default preset", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-store-override-"));
    const { saveSettings } = await import("./settings.js");
    await saveSettings(dataDir, {
      presets: { repos: [{ id: "biz", name: "B", repoPath: "/data/default" }] },
      jobTypes: { defaultPresetId: { docs: "biz" } },
    });
    const job = await createJob(
      dataDir,
      {
        branch: "docs/x",
        jobType: "docs",
        docsTemplate: "research",
        repoPath: "/override/path",
        dryRun: true,
      },
      createDefaults(dataDir),
    );
    assert.equal(job.input.repoPath, "/override/path");
  });
});
