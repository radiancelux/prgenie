import type { RunnerConfig } from "./config.js";
import type { git } from "./github.js";
import { isSafeJobId } from "./paths.js";
import {
  listJobs,
  loadArchivedJob,
  loadJob,
  moveJobToArchive,
  restoreJobFromArchive,
} from "./store.js";
import { isJobSettling } from "./job-settling.js";
import type { JobRecord, JobStage } from "./types.js";
import { tryRemoveJobWorktree, type TryCleanupResult } from "./worktree-cleanup.js";

/** Stages a job may be archived from; building/reviewing/fixing are running unless still queued. */
export const ARCHIVABLE_STAGES: ReadonlySet<JobStage> = new Set<JobStage>([
  "failed",
  "stuck",
  "stopped",
  "approved",
  "changes_remaining",
]);

export function clearFailedStages(includeStuckStopped: boolean): ReadonlySet<JobStage> {
  return new Set<JobStage>(includeStuckStopped ? ["failed", "stuck", "stopped"] : ["failed"]);
}

export type ArchiveWorktreeOutcome = "removed" | "kept" | "none";

export type ArchiveJobResult =
  | {
      ok: true;
      id: string;
      archivedAt: string;
      worktree: ArchiveWorktreeOutcome;
      warning?: string;
    }
  | {
      ok: false;
      code: "invalid_id" | "not_found" | "running";
      error: string;
      stage?: JobStage;
    };

export type RestoreJobResult =
  | { ok: true; id: string; job: JobRecord }
  | { ok: false; code: "invalid_id" | "not_found" | "collision"; error: string };

export type ClearFailedResult = {
  ok: true;
  stages: JobStage[];
  archived: string[];
  warnings: Array<{ id: string; warning: string }>;
  skipped: Array<{ id: string; error: string }>;
};

export type ArchiveDeps = {
  /** True while the engine still has a loop for this job (e.g. stop requested, not yet settled). */
  isRunning?: (jobId: string) => boolean;
  isSettling?: (jobId: string) => Promise<boolean>;
  dataDir?: string;
  gitImpl?: typeof git;
  log?: (msg: string) => void;
  /** Defaults to the managed worktrees root; tests point it at a temp dir. */
  worktreesRoot?: string;
};

function keptWorktreeWarning(worktreePath: string, res: TryCleanupResult): string {
  let why: string;
  if ("skipped" in res) {
    why =
      res.skipped === "dirty"
        ? "it has uncommitted changes"
        : res.skipped === "unpushed"
          ? "the branch has commits that are not on origin"
          : res.skipped === "outside_managed_root"
            ? "it is outside the runner's managed worktrees directory"
            : res.skipped;
  } else if ("reason" in res) {
    why = res.reason;
  } else {
    why = "unknown";
  }
  return `Worktree kept at ${worktreePath} because ${why}. Clean it up manually to free the branch.`;
}

/** Remove the job's worktree when clean; dirty or unpushed trees are kept (never forced). */
async function releaseJobWorktree(
  config: RunnerConfig,
  job: JobRecord,
  deps: ArchiveDeps,
): Promise<{ worktree: ArchiveWorktreeOutcome; warning?: string }> {
  const wt = job.worktreePath?.trim();
  if (!wt) return { worktree: "none" };
  const res = await tryRemoveJobWorktree(config, job, {
    reason: "archived",
    gitImpl: deps.gitImpl,
    log: deps.log,
    worktreesRoot: deps.worktreesRoot,
  });
  if (res.removed) return { worktree: "removed" };
  if ("skipped" in res && res.skipped === "repo_checkout") return { worktree: "none" };
  return { worktree: "kept", warning: keptWorktreeWarning(wt, res) };
}

async function jobStillRunning(id: string, deps: ArchiveDeps): Promise<boolean> {
  if (deps.isRunning?.(id)) return true;
  if (deps.isSettling) return deps.isSettling(id);
  if (deps.dataDir) return isJobSettling(deps.dataDir, id);
  return false;
}

export async function archiveJob(
  config: RunnerConfig,
  id: string,
  deps: ArchiveDeps = {},
): Promise<ArchiveJobResult> {
  if (!isSafeJobId(id)) return { ok: false, code: "invalid_id", error: "invalid job id" };
  const archived = await loadArchivedJob(config.dataDir, id);
  if (archived?.archivedAt) {
    return {
      ok: true,
      id,
      archivedAt: archived.archivedAt,
      worktree: archived.worktreePath ? "kept" : "none",
    };
  }
  const job = await loadJob(config.dataDir, id);
  if (!job) return { ok: false, code: "not_found", error: "job not found" };
  const archivable = ARCHIVABLE_STAGES.has(job.stage) || Boolean(job.queueState?.queued);
  if (!archivable || (await jobStillRunning(id, deps))) {
    return {
      ok: false,
      code: "running",
      error: `job is still running (${job.stage}); stop it before removing`,
      stage: job.stage,
    };
  }
  const released = await releaseJobWorktree(config, job, deps);
  try {
    await moveJobToArchive(config.dataDir, job);
  } catch (err) {
    const again = await loadArchivedJob(config.dataDir, id);
    if (again?.archivedAt) {
      return {
        ok: true,
        id,
        archivedAt: again.archivedAt,
        worktree: again.worktreePath ? "kept" : "none",
      };
    }
    throw err;
  }
  return { ok: true, id, archivedAt: job.archivedAt ?? new Date().toISOString(), ...released };
}

export async function restoreJob(config: RunnerConfig, id: string): Promise<RestoreJobResult> {
  if (!isSafeJobId(id)) return { ok: false, code: "invalid_id", error: "invalid job id" };
  const res = await restoreJobFromArchive(config.dataDir, id);
  if (!res.ok) return res;
  return { ok: true, id, job: res.job };
}

/** Archive every live job in `failed` (optionally also `stuck` / `stopped`). */
export async function clearFailedJobs(
  config: RunnerConfig,
  opts: { includeStuckStopped?: boolean } & ArchiveDeps = {},
): Promise<ClearFailedResult> {
  const stages = clearFailedStages(Boolean(opts.includeStuckStopped));
  const result: ClearFailedResult = {
    ok: true,
    stages: [...stages],
    archived: [],
    warnings: [],
    skipped: [],
  };
  for (const job of await listJobs(config.dataDir)) {
    if (!stages.has(job.stage)) continue;
    const r = await archiveJob(config, job.id, opts);
    if (r.ok) {
      result.archived.push(r.id);
      if (r.warning) result.warnings.push({ id: r.id, warning: r.warning });
    } else {
      result.skipped.push({ id: job.id, error: r.error });
    }
  }
  return result;
}
