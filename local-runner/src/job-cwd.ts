import { existsSync } from "node:fs";
import type { JobRecord } from "./types.js";

/** Cwd for gh/origin/git spawns: live worktree, else repo root. */
export function resolveJobSpawnCwd(job: Pick<JobRecord, "worktreePath" | "input">): string | null {
  const wt = job.worktreePath?.trim();
  if (wt && existsSync(wt)) return wt;
  const repo = job.input.repoPath?.trim();
  return repo || null;
}

export function isJobArchived(job: Pick<JobRecord, "archivedAt">): boolean {
  return job.archivedAt != null && job.archivedAt !== "";
}
