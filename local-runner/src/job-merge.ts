import { fetchPrMerged, type FetchPrMergedFn } from "./github.js";
import { isJobArchived, resolveJobSpawnCwd } from "./job-cwd.js";
import { saveJob } from "./store.js";
import type { JobRecord } from "./types.js";

/** If the linked PR is merged, set archivedAt and persist. Returns true when archived. */
export async function archiveJobIfPrMerged(
  dataDir: string,
  job: JobRecord,
  fetchMerged: FetchPrMergedFn = fetchPrMerged,
): Promise<{ job: JobRecord; archived: boolean }> {
  if (isJobArchived(job)) return { job, archived: false };
  const hasPr = job.prNumber != null || job.prUrl != null;
  if (!hasPr) return { job, archived: false };

  const cwd = resolveJobSpawnCwd(job);
  if (!cwd) return { job, archived: false };

  const { merged, mergedAt } = await fetchMerged(cwd, {
    prNumber: job.prNumber,
    branch: job.input.branch,
  });
  if (!merged) return { job, archived: false };

  job.archivedAt = mergedAt ?? new Date().toISOString();
  await saveJob(dataDir, job);
  return { job, archived: true };
}
