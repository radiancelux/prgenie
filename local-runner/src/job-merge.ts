import { fetchPrMerged, type FetchPrMergedFn } from "./github.js";
import { resolveJobSpawnCwd } from "./job-cwd.js";
import { patchJob } from "./store.js";
import type { JobRecord } from "./types.js";
import { isMergedStatus } from "./ci.js";

/** When GitHub reports merged, persist Status=merged and mergedAt (row stays visible ~1h). */
export async function syncJobMergedStatus(
  dataDir: string,
  job: JobRecord,
  fetchMerged: FetchPrMergedFn = fetchPrMerged,
): Promise<{ job: JobRecord; updated: boolean }> {
  if (isMergedStatus(job)) return { job, updated: false };
  const hasPr = job.prNumber != null || job.prUrl != null;
  if (!hasPr) return { job, updated: false };

  const cwd = resolveJobSpawnCwd(job);
  if (!cwd) return { job, updated: false };

  const { merged, mergedAt } = await fetchMerged(cwd, {
    prNumber: job.prNumber,
    branch: job.input.branch,
  });
  if (!merged) return { job, updated: false };

  const ciStatus: JobRecord["ciStatus"] = {
    status: "merged",
    summary: "merged",
    mergedAt: mergedAt ?? new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    source: "github",
  };
  job.ciStatus = ciStatus;
  await patchJob(dataDir, job.id, (fresh) => {
    fresh.ciStatus = ciStatus;
  });
  return { job, updated: true };
}

/** @deprecated Use syncJobMergedStatus — kept for tests importing archiveJobIfPrMerged */
export const archiveJobIfPrMerged = syncJobMergedStatus;
