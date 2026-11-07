import type { JobRecord } from "./types.js";
import { listJobs } from "./store.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export type QueueDecision =
  | { action: "run"; reason: string }
  | { action: "queue"; reason: string; position: number }
  | { action: "reject"; reason: string };

export type QueueOptions = {
  /** In-process liveness: a stop-requested job keeps its slot and branch until its loop exits. */
  isRunning?: (jobId: string) => boolean;
};

/** Another live or queued job already owns this branch; HTTP maps this to 409. */
export class BranchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchConflictError";
  }
}

function isLive(j: JobRecord, opts: QueueOptions): boolean {
  if (!ACTIVE_STAGES.has(j.stage)) return false;
  return !j.stopRequested || Boolean(opts.isRunning?.(j.id));
}

function isQueued(j: JobRecord): boolean {
  return ACTIVE_STAGES.has(j.stage) && !j.stopRequested && Boolean(j.queueState?.queued);
}

function sameBranch(j: JobRecord, branch: string, repoSlug: string): boolean {
  return j.input.branch.trim() === branch.trim() && j.repoSlug === repoSlug;
}

function runningJobs(jobs: JobRecord[], opts: QueueOptions): JobRecord[] {
  return jobs.filter((j) => isLive(j, opts) && !j.queueState?.queued);
}

export function countActiveJobs(jobs: JobRecord[], opts: QueueOptions = {}): number {
  return runningJobs(jobs, opts).length;
}

/** Running and queued jobs both hold their branch: a queued job will run on it later. */
export function jobsHoldingBranch(
  jobs: JobRecord[],
  branch: string,
  repoSlug: string,
  opts: QueueOptions = {},
): JobRecord[] {
  return jobs.filter((j) => (isQueued(j) || isLive(j, opts)) && sameBranch(j, branch, repoSlug));
}

export function queuedJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs.filter(isQueued).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function decideJobStart(
  jobs: JobRecord[],
  branch: string,
  repoSlug: string,
  maxActive: number,
  opts: QueueOptions = {},
): QueueDecision {
  if (jobsHoldingBranch(jobs, branch, repoSlug, opts).length > 0) {
    return {
      action: "reject",
      reason: `another active job is already using branch ${branch}`,
    };
  }
  const active = countActiveJobs(jobs, opts);
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
export function runnableQueuedJobs(
  jobs: JobRecord[],
  maxActive: number,
  opts: QueueOptions = {},
): JobRecord[] {
  const running = runningJobs(jobs, opts);
  const picked: JobRecord[] = [];
  for (const q of queuedJobs(jobs)) {
    if (running.length + picked.length >= maxActive) break;
    const held = [...running, ...picked].some((r) => sameBranch(r, q.input.branch, q.repoSlug));
    if (!held) picked.push(q);
  }
  return picked;
}
