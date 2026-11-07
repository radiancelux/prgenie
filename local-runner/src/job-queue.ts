import type { JobRecord } from "./types.js";
import { listJobs } from "./store.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export type QueueDecision =
  | { action: "run"; reason: string }
  | { action: "queue"; reason: string; position: number }
  | { action: "reject"; reason: string };

export function countActiveJobs(jobs: JobRecord[]): number {
  return jobs.filter((j) => ACTIVE_STAGES.has(j.stage) && !j.stopRequested && !j.queueState?.queued)
    .length;
}

export function activeJobsOnBranch(
  jobs: JobRecord[],
  branch: string,
  repoKey: string,
): JobRecord[] {
  const b = branch.trim();
  return jobs.filter(
    (j) =>
      ACTIVE_STAGES.has(j.stage) &&
      !j.stopRequested &&
      !j.queueState?.queued &&
      j.input.branch.trim() === b &&
      (j.repoSlug === repoKey || j.input.repoPath === repoKey),
  );
}

export function queuedJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs
    .filter((j) => j.queueState?.queued)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function decideJobStart(
  jobs: JobRecord[],
  branch: string,
  repoKey: string,
  maxActive: number,
): QueueDecision {
  if (activeJobsOnBranch(jobs, branch, repoKey).length > 0) {
    return {
      action: "reject",
      reason: `another active job is already using branch ${branch}`,
    };
  }
  const active = countActiveJobs(jobs);
  if (active < maxActive) {
    return { action: "run", reason: `${active}/${maxActive} active slots in use` };
  }
  const position = queuedJobs(jobs).length + 1;
  return {
    action: "queue",
    reason: `queue cap ${maxActive} active jobs reached`,
    position,
  };
}

export async function listJobsForQueue(dataDir: string): Promise<JobRecord[]> {
  return listJobs(dataDir);
}

export function nextQueuedJob(jobs: JobRecord[]): JobRecord | null {
  const q = queuedJobs(jobs);
  return q[0] ?? null;
}
