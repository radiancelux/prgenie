import { access } from "node:fs/promises";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { managedWorktreesRoot } from "./paths.js";
import { shouldHideMergedJob } from "./ci.js";
import { fetchPrMerged, git, isBranchSyncedWithOrigin } from "./github.js";
import { resolveJobSpawnCwd } from "./job-cwd.js";
import { syncJobMergedStatus } from "./job-merge.js";
import { setJobError } from "./job-error.js";
import { patchJob } from "./store.js";
import type { JobRecord } from "./types.js";
import { removeWorktree } from "./worktree.js";

export type WorktreeCleanupReason =
  "merged_hidden" | "terminal_merged" | "terminal_branch_gone" | "archived" | null;

export async function worktreePathExists(worktreePath: string | null): Promise<boolean> {
  if (!worktreePath?.trim()) return false;
  try {
    await access(worktreePath.trim());
    return true;
  } catch {
    return false;
  }
}

export async function worktreeHasUncommittedChanges(
  worktreePath: string,
  gitImpl: typeof git = git,
): Promise<boolean> {
  const status = await gitImpl(worktreePath, ["status", "--porcelain"]);
  if (status.code !== 0) return true;
  return status.stdout.trim().length > 0;
}

export async function branchExistsOnOrigin(
  cwd: string,
  branch: string,
  gitImpl: typeof git = git,
): Promise<boolean> {
  const res = await gitImpl(cwd, ["ls-remote", "--heads", "origin", branch]);
  if (res.code !== 0) return true;
  return res.stdout.trim().length > 0;
}

export function worktreeCleanupReason(job: JobRecord, nowMs = Date.now()): WorktreeCleanupReason {
  if (!job.worktreePath?.trim()) return null;
  if (shouldHideMergedJob(job, nowMs)) return "merged_hidden";
  const terminal = new Set(["failed", "stopped", "changes_remaining", "approved", "stuck"]);
  if (!terminal.has(job.stage)) return null;
  if (job.ciStatus?.status === "merged" || job.ciStatus?.mergedAt) {
    return "terminal_merged";
  }
  return null;
}

export type TryCleanupResult =
  | { removed: true }
  | {
      removed: false;
      skipped:
        | "dirty"
        | "unpushed"
        | "branch_exists"
        | "missing_path"
        | "repo_checkout"
        | "outside_managed_root";
    }
  | { removed: false; reason: string };

function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Dry-run jobs record the repo checkout itself as worktreePath; only paths the runner created
 * under the managed worktrees root may ever be removed.
 */
export function unremovableWorktreeReason(
  worktreePath: string,
  repoPath: string,
  worktreesRoot: string,
): "repo_checkout" | "outside_managed_root" | null {
  const wt = path.resolve(worktreePath);
  const repo = path.resolve(repoPath);
  if (wt === repo || isStrictlyInside(wt, repo)) return "repo_checkout";
  if (!isStrictlyInside(path.resolve(worktreesRoot), wt)) return "outside_managed_root";
  return null;
}

async function persistWorktreeCleared(config: RunnerConfig, job: JobRecord): Promise<void> {
  job.worktreePath = null;
  await patchJob(config.dataDir, job.id, (fresh) => {
    fresh.worktreePath = null;
  });
}

async function persistCleanupError(config: RunnerConfig, job: JobRecord, msg: string) {
  job.error = setJobError(job.error, msg);
  await patchJob(config.dataDir, job.id, (fresh) => {
    fresh.error = setJobError(fresh.error, msg);
  });
}

export async function tryRemoveJobWorktree(
  config: RunnerConfig,
  job: JobRecord,
  opts: {
    reason: WorktreeCleanupReason;
    gitImpl?: typeof git;
    log?: (msg: string) => void;
    worktreesRoot?: string;
  },
): Promise<TryCleanupResult> {
  const wt = job.worktreePath?.trim();
  if (!wt) return { removed: false, skipped: "missing_path" };

  const repoRoot = job.input.repoPath?.trim();
  if (!repoRoot) return { removed: false, reason: "no repoPath" };

  const gitImpl = opts.gitImpl ?? git;
  const exists = await worktreePathExists(wt);
  if (!exists) {
    await persistWorktreeCleared(config, job);
    return { removed: true };
  }

  const unremovable = unremovableWorktreeReason(
    wt,
    repoRoot,
    opts.worktreesRoot ?? managedWorktreesRoot(),
  );
  if (unremovable) {
    opts.log?.(`worktree cleanup skipped (${opts.reason}): ${unremovable} ${wt}`);
    return { removed: false, skipped: unremovable };
  }

  if (await worktreeHasUncommittedChanges(wt, gitImpl)) {
    const msg = `worktree cleanup skipped (${opts.reason}): uncommitted changes in ${wt}`;
    opts.log?.(msg);
    await persistCleanupError(config, job, msg);
    return { removed: false, skipped: "dirty" };
  }

  const sync = await isBranchSyncedWithOrigin(wt, job.input.branch, gitImpl);
  if (!sync.ok) {
    const msg = `worktree cleanup skipped (${opts.reason}): ${sync.reason}`;
    opts.log?.(msg);
    await persistCleanupError(config, job, msg);
    return { removed: false, skipped: "unpushed" };
  }

  if (
    opts.reason === "terminal_merged" ||
    opts.reason === "merged_hidden" ||
    opts.reason === "archived"
  ) {
    // ok
  } else if (job.stage === "failed" || job.stage === "stopped") {
    const onOrigin = await branchExistsOnOrigin(wt, job.input.branch, gitImpl);
    if (onOrigin) {
      return { removed: false, skipped: "branch_exists" };
    }
  }

  await removeWorktree(repoRoot, wt);
  await persistWorktreeCleared(config, job);
  opts.log?.(`worktree removed (${opts.reason}): ${wt}`);
  return { removed: true };
}

/** Called from CI poll / list hooks — idempotent, never throws. */
export async function maybeCleanupJobWorktree(
  config: RunnerConfig,
  job: JobRecord,
  nowMs = Date.now(),
  log?: (msg: string) => void,
): Promise<void> {
  try {
    await syncJobMergedStatus(config.dataDir, job, fetchPrMerged);
    let reason = worktreeCleanupReason(job, nowMs);
    if (!reason && (job.stage === "failed" || job.stage === "stopped") && job.worktreePath) {
      const cwd = resolveJobSpawnCwd(job);
      if (cwd) {
        const gone = !(await branchExistsOnOrigin(cwd, job.input.branch));
        if (gone) reason = "terminal_branch_gone";
      }
    }
    if (!reason) return;
    await tryRemoveJobWorktree(config, job, { reason, log });
  } catch (err) {
    log?.(`worktree cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function cleanupHiddenMergedWorktrees(
  config: RunnerConfig,
  jobs: JobRecord[],
  nowMs = Date.now(),
  log?: (msg: string) => void,
): Promise<void> {
  for (const job of jobs) {
    if (shouldHideMergedJob(job, nowMs) && job.worktreePath) {
      await tryRemoveJobWorktree(config, job, { reason: "merged_hidden", log });
    }
  }
}
