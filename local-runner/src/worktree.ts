import { mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { cursorWorktreeDir, repoSlugFromPath } from "./paths.js";
import { git, type GhResult } from "./github.js";
import { baseRefProbeOrder, resolveWorktreeBaseRef } from "./repo-base.js";
import type { RunnerSettings } from "./settings.js";
import { listJobs } from "./store.js";

export async function cloneRepo(remote: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const parent = path.dirname(dest);
  const name = path.basename(dest);
  const r = await git(parent, ["clone", remote, name]);
  if (r.code !== 0) {
    throw new Error(`git clone failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

async function enrichWorktreeAddFailure(
  repoPath: string,
  branch: string,
  rawErr: string,
  dataDir?: string,
): Promise<string> {
  const used = rawErr.match(/already used by worktree at '([^']+)'/i);
  if (!used) return `git worktree add failed: ${rawErr || "no base ref found"}`;
  const wtPath = used[1];
  let hint = `git worktree remove ${wtPath}`;
  if (dataDir) {
    const jobs = await listJobs(dataDir);
    const owner = jobs.find((j) => j.worktreePath?.trim() === wtPath);
    if (owner) {
      hint = `archive job ${owner.id} on the dashboard, or \`git worktree remove ${wtPath}\` and \`git branch -D ${branch}\``;
    }
  }
  return `git worktree add failed: branch "${branch}" is already checked out at ${wtPath} — ${hint}`;
}

export async function branchHasNoCommitsBeyondBase(
  cwd: string,
  settings?: RunnerSettings,
  gitImpl: (cwd: string, args: string[]) => Promise<GhResult> = git,
): Promise<boolean> {
  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  for (const base of bases) {
    const probe = await gitImpl(cwd, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    const count = await gitImpl(cwd, ["rev-list", "--count", `${base.trim()}..HEAD`]);
    if (count.code !== 0) return false;
    return Number(count.stdout.trim()) === 0;
  }
  const head = await gitImpl(cwd, ["rev-parse", "HEAD"]);
  return head.code === 0;
}

export async function deleteLocalBranch(
  repoPath: string,
  branch: string,
  gitImpl: (cwd: string, args: string[]) => Promise<GhResult> = git,
): Promise<void> {
  if (!branch.trim()) return;
  await gitImpl(repoPath, ["branch", "-D", branch]).catch(() => undefined);
}

export async function ensureWorktree(
  repoPath: string,
  jobId: string,
  branch: string,
  settings?: RunnerSettings,
  opts?: { dataDir?: string },
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
  throw new Error(await enrichWorktreeAddFailure(repoPath, branch, lastErr, opts?.dataDir));
}

/** Reuse an existing job worktree when present; otherwise add one at `origin/<branch>`. */
export async function ensureContinueWorktree(
  repoPath: string,
  jobId: string,
  branch: string,
  existingPath: string | null,
  settings?: RunnerSettings,
): Promise<{ path: string; reused: boolean }> {
  const slug = repoSlugFromPath(repoPath);
  const wt = existingPath?.trim() || cursorWorktreeDir(slug, jobId);
  if (existingPath?.trim()) {
    try {
      await access(existingPath);
      const listed = await git(repoPath, ["worktree", "list", "--porcelain"]);
      if (listed.stdout.includes(`worktree ${existingPath}`)) {
        return { path: existingPath, reused: true };
      }
    } catch {
      /* recreate below */
    }
  }
  const listed = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (listed.stdout.includes(`worktree ${wt}`)) {
    try {
      await access(wt);
      return { path: wt, reused: true };
    } catch {
      await git(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
      await rm(wt, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await mkdir(path.dirname(wt), { recursive: true });
  await git(repoPath, ["fetch", "origin"]);
  const remoteRef = `origin/${branch}`;
  const probe = await git(repoPath, ["rev-parse", "--verify", remoteRef]);
  if (probe.code === 0) {
    const add = await git(repoPath, ["worktree", "add", "-B", branch, wt, remoteRef]);
    if (add.code === 0) return { path: wt, reused: false };
    throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const pathFromEnsure = await ensureWorktree(repoPath, jobId, branch, settings);
  return { path: pathFromEnsure, reused: false };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { branch?: string; deleteBranch?: boolean },
): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  if (opts?.deleteBranch && opts.branch?.trim()) {
    await deleteLocalBranch(repoPath, opts.branch);
  }
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
