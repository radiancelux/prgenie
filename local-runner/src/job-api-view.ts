import type { JobRecord } from "./types.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export type JobPublicView = JobRecord & {
  /** Same as input.branch — top-level for API clients (#204). */
  branch: string;
  queued: boolean;
  queuePosition: number | null;
  /** Human status when watchdog activity is not set yet (#203). */
  activityMessage: string | null;
  logTail?: string;
};

export function jobActivityMessage(job: JobRecord): string | null {
  const queued = Boolean(job.queueState?.queued);
  if (queued) {
    const pos = job.queueState?.position;
    return pos != null ? `Queued (position ${pos})` : "Queued";
  }
  if (!ACTIVE_STAGES.has(job.stage) || job.stopRequested) return null;
  if (!job.dryRun && !job.worktreePath) {
    return "Preparing worktree";
  }
  if (job.runtime?.waitMode === "command" && job.runtime.command?.summary) {
    return `Preparing: ${job.runtime.command.summary}`;
  }
  if (job.runtime?.waitMode === "agent") {
    return "Agent running";
  }
  if (!job.watchdog?.lastActivityAt && !job.dryRun && job.worker) {
    return "Starting worker";
  }
  return null;
}

export function enrichJobPublicView(job: JobRecord, extra?: { logTail?: string }): JobPublicView {
  const queued = Boolean(job.queueState?.queued);
  const queuePosition = queued ? (job.queueState?.position ?? null) : null;
  const branch = job.input?.branch?.trim() ?? "";
  const activityMessage = jobActivityMessage(job);
  const base = { ...job } as JobRecord & { branch?: string | null };
  delete base.branch;
  return {
    ...base,
    branch,
    queued,
    queuePosition,
    activityMessage,
    ...(extra?.logTail !== undefined ? { logTail: extra.logTail } : {}),
  };
}
