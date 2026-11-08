import type { RunnerConfig } from "./config.js";
import { loadJob, saveJob } from "./store.js";
import type { JobRecord } from "./types.js";
import { setJobError } from "./job-error.js";
import { clearDeadWorker } from "./job-worker-lock.js";

export type MarkInterruptedReason =
  "worker_exit" | "worker_missing" | "adoption_failed" | "worker_watchdog";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

/**
 * Settle a job whose worker is confirmed dead. Callers must not use this while the worker may
 * still run. A pending stop lands on `stopped`; otherwise an active job becomes `interrupted`.
 * Jobs that already reached a terminal stage keep it.
 */
export async function markJobInterrupted(
  config: RunnerConfig,
  jobId: string,
  reason: MarkInterruptedReason,
  detail?: string,
): Promise<JobRecord | null> {
  await clearDeadWorker(config.dataDir, jobId);
  const job = await loadJob(config.dataDir, jobId);
  if (!job) return null;
  if (!ACTIVE_STAGES.has(job.stage)) return job;
  if (job.stopRequested) {
    job.stage = "stopped";
  } else {
    const msg = detail?.trim()
      ? `Interrupted (${reason}: ${detail}); use continue_job to resume.`
      : `Interrupted (${reason}); use continue_job to resume.`;
    job.error = setJobError(job.error, msg);
    job.stage = "interrupted";
  }
  await saveJob(config.dataDir, job);
  return job;
}
