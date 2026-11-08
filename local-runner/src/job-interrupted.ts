import type { RunnerConfig } from "./config.js";
import { loadJob, saveJob } from "./store.js";
import type { JobRecord } from "./types.js";
import { setJobError } from "./job-error.js";

export type MarkInterruptedReason = "worker_exit" | "worker_missing" | "adoption_failed";

export async function markJobInterrupted(
  config: RunnerConfig,
  jobId: string,
  reason: MarkInterruptedReason,
  detail?: string,
): Promise<JobRecord | null> {
  const job = await loadJob(config.dataDir, jobId);
  if (!job) return null;
  const msg = detail?.trim()
    ? `Runner restart: ${reason} (${detail})`
    : `Runner restart: ${reason}; use continue_job to resume.`;
  job.error = setJobError(job.error, msg);
  job.stage = "interrupted";
  job.worker = undefined;
  job.stopRequested = false;
  await saveJob(config.dataDir, job);
  return job;
}
