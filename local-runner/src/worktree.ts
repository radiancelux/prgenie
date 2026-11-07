import { mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { cursorWorktreeDir, repoSlugFromPath } from "./paths.js";
import { git } from "./github.js";
import { baseRefProbeOrder, resolveWorktreeBaseRef } from "./repo-base.js";
import type { RunnerSettings } from "./settings.js";

export async function cloneRepo(remote: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const parent = path.dirname(dest);
  const name = path.basename(dest);
  const r = await git(parent, ["clone", remote, name]);
  if (r.code !== 0) {
    throw new Error(`git clone failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export async function ensureWorktree(
  repoPath: string,
  jobId: string,
  branch: string,
  settings?: RunnerSettings,
): Promise<string> {
  const slug = repoSlugFromPath(repoPath);
  const wt = cursorWorktreeDir(slug, jobId);
  await mkdir(path.dirname(wt), { recursive: true });
  const exists = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const listed = exists.stdout.includes(`worktree ${wt}`);
  let onDisk = false;
  try {
    await access(wt);
    onDisk = true;
  } catch {
    onDisk = false;
  }
  if (listed && onDisk) {
    return wt;
  }
  if (listed && !onDisk) {
    await git(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(wt, { recursive: true, force: true }).catch(() => undefined);
  }
  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  let lastErr = "";
  for (const base of bases) {
    const probe = await git(repoPath, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    const add = await git(repoPath, ["worktree", "add", "-B", branch, wt, base]);
    if (add.code === 0) return wt;
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  if (settings) {
    const resolved = await resolveWorktreeBaseRef(repoPath, settings);
    const add = await git(repoPath, ["worktree", "add", "-B", branch, wt, resolved.ref]);
    if (add.code === 0) return wt;
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  throw new Error(`git worktree add failed: ${lastErr || "no base ref found"}`);
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
}

export async function rebaseOntoBase(worktree: string, settings?: RunnerSettings): Promise<void> {
  await git(worktree, ["fetch", "origin"]);
  const order = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  for (const base of order) {
    const probe = await git(worktree, ["rev-parse", "--verify", base]);
    if (probe.code === 0) {
      const rb = await git(worktree, ["rebase", base]);
      if (rb.code !== 0) {
        throw new Error(`git rebase ${base} failed: ${rb.stderr.trim()}`);
      }
      return;
    }
  }
  throw new Error("Could not find origin/main or origin/master for rebase");
}
