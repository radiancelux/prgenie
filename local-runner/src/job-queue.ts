import type { JobRecord } from "./types.js";
import { listJobs } from "./store.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export type QueueDecision =
  | { action: "run"; reason: string }
  | { action: "queue"; reason: string; position: number }
  | { action: "reject"; reason: string };

/** Another live or queued job already owns this branch; HTTP maps this to 409. */
export class BranchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchConflictError";
  }
}

function isLive(j: JobRecord): boolean {
  return ACTIVE_STAGES.has(j.stage) && !j.stopRequested;
}

function isQueued(j: JobRecord): boolean {
  return isLive(j) && Boolean(j.queueState?.queued);
}

function sameBranch(j: JobRecord, branch: string, repoSlug: string): boolean {
  return j.input.branch.trim() === branch.trim() && j.repoSlug === repoSlug;
}

export function countActiveJobs(jobs: JobRecord[]): number {
  return jobs.filter((j) => isLive(j) && !j.queueState?.queued).length;
}

/** Running and queued jobs both hold their branch: a queued job will run on it later. */
export function jobsHoldingBranch(
  jobs: JobRecord[],
  branch: string,
  repoSlug: string,
): JobRecord[] {
  return jobs.filter((j) => isLive(j) && sameBranch(j, branch, repoSlug));
}

export function queuedJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs.filter(isQueued).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function decideJobStart(
  jobs: JobRecord[],
  branch: string,
  repoSlug: string,
  maxActive: number,
): QueueDecision {
  if (jobsHoldingBranch(jobs, branch, repoSlug).length > 0) {
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

/** Oldest queued jobs that fit in the free slots, skipping any whose branch is already running. */
export function runnableQueuedJobs(jobs: JobRecord[], maxActive: number): JobRecord[] {
  const running = jobs.filter((j) => isLive(j) && !j.queueState?.queued);
  const picked: JobRecord[] = [];
  for (const q of queuedJobs(jobs)) {
    if (running.length + picked.length >= maxActive) break;
    const held = [...running, ...picked].some((r) => sameBranch(r, q.input.branch, q.repoSlug));
    if (!held) picked.push(q);
  }
  return picked;
}
