import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob, listJobs, loadJob } from "./store.js";

const createDefaults = {
  model: "composer-2.5",
  dryRun: true,
  config: { defaultCodeRepoPath: null },
};

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
      { model: "composer-2.5", dryRun: false, config: { defaultCodeRepoPath: null } },
    );
    assert.equal(job.stage, "building");
    const again = await loadJob(dataDir, job.id);
    assert.ok(again);
    assert.equal(again.input.branch, "feat/x");
    const all = await listJobs(dataDir);
    assert.equal(all.length, 1);
  });

  it("infers Linear ticket from branch name", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-store-"));
    const job = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: "feat/rad-320-verdict-resend",
        promptFile: "/tmp/prompt.md",
        dryRun: true,
      },
      createDefaults,
    );
    assert.equal(job.linearIssue, "RAD-320");
    assert.equal(job.ticketUrl, "https://linear.app/radiancelux/issue/RAD-320");
    assert.equal(job.title, "feat/rad-320-verdict-resend");
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
      { model: "composer-2.5", dryRun: true, config: { defaultCodeRepoPath: null } },
    );
    assert.equal(explicit.title, "My agent");

    const dataDir2 = await mkdtemp(path.join(os.tmpdir(), "lr-store-"));
    const fromSlug = await createJob(
      dataDir2,
      {
        repoPath: "/tmp/repo",
        branch: "feat/x",
        promptFile: "/tmp/prompt.md",
        ticketUrl: "https://linear.app/radiancelux/issue/RAD-327/dashboard-script-parse",
        dryRun: true,
      },
      { model: "composer-2.5", dryRun: true, config: { defaultCodeRepoPath: null } },
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
      createDefaults,
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
      createDefaults,
    );
    assert.equal(job.input.repoPath, "/override/path");
  });
});
