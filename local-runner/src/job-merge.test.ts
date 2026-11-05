import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveJobIfPrMerged } from "./job-merge.js";
import { createJob, listJobs, loadJob } from "./store.js";

describe("archiveJobIfPrMerged", () => {
  it("sets archivedAt when gh reports merged", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-merge-"));
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true },
    );
    job.prNumber = 99;
    job.prUrl = "https://github.com/o/r/pull/99";

    const { archived, job: updated } = await archiveJobIfPrMerged(dataDir, job, async () => ({
      merged: true,
      mergedAt: "2026-11-05T12:00:00.000Z",
    }));
    assert.equal(archived, true);
    assert.equal(updated.archivedAt, "2026-11-05T12:00:00.000Z");

    const onDisk = await loadJob(dataDir, job.id);
    assert.equal(onDisk?.archivedAt, "2026-11-05T12:00:00.000Z");
    assert.equal((await listJobs(dataDir)).length, 0);
    assert.equal((await listJobs(dataDir, { includeArchived: true })).length, 1);
  });
});
