import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob, listJobs, loadJob } from "./store.js";

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
      { model: "composer-2.5", dryRun: false },
    );
    assert.equal(job.stage, "building");
    const again = await loadJob(dataDir, job.id);
    assert.ok(again);
    assert.equal(again.input.branch, "feat/x");
    const all = await listJobs(dataDir);
    assert.equal(all.length, 1);
  });
});
