import { mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { cursorWorktreeDir, repoSlugFromPath } from "./paths.js";
import { git, type GhResult } from "./github.js";
import { baseRefProbeOrder, resolveWorktreeBaseRef, type GitFn } from "./repo-base.js";
import type { RunnerSettings } from "./settings.js";
import { listJobs } from "./store.js";

export type WorktreeEnsureResult = {
  path: string;
  baseRef: string;
  baseSha: string;
};

export type WorktreeOpts = {
  dataDir?: string;
  gitImpl?: GitFn;
};

export function worktreePathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a.trim());
  const nb = path.resolve(b.trim());
  if (process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** Parse `git worktree list --porcelain` and return the checkout path for a local branch, if any. */
export function parseWorktreePathForBranch(porcelain: string, branch: string): string | null {
  const branchRef = `refs/heads/${branch.trim()}`;
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath) {
      const ref = line.slice("branch ".length).trim();
      if (ref === branchRef) return currentPath;
    }
  }
  return null;
}

export async function bestEffortFetchOrigin(repoPath: string, gitImpl: GitFn = git): Promise<void> {
  await gitImpl(repoPath, ["fetch", "origin"]).catch(() => undefined);
}

export async function assertSafeToResetBranchAtBase(
  repoPath: string,
  branch: string,
  base: string,
  gitImpl: GitFn = git,
): Promise<void> {
  const exists = await gitImpl(repoPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (exists.code !== 0) return;
  const count = await gitImpl(repoPath, ["rev-list", "--count", `${base.trim()}..${branch}`]);
  if (count.code !== 0) return;
  const n = Number(count.stdout.trim());
  if (n > 0) {
    throw new Error(
      `refusing to reset local branch "${branch}": it has ${n} commit(s) not reachable from ${base.trim()}. Use a fresh branch name.`,
    );
  }
}

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
    const owner = jobs.find(
      (j) => j.worktreePath?.trim() && worktreePathsEqual(j.worktreePath, wtPath),
    );
    if (owner) {
      hint = `archive job ${owner.id} on the dashboard, or \`git worktree remove ${wtPath}\` and \`git branch -D ${branch}\``;
    }
  }
  return `git worktree add failed: branch "${branch}" is already checked out at ${wtPath} — ${hint}`;
}

async function resolveBaseTip(
  repoPath: string,
  base: string,
  gitImpl: GitFn,
): Promise<{ baseRef: string; baseSha: string } | null> {
  const probe = await gitImpl(repoPath, ["rev-parse", "--verify", base.trim()]);
  if (probe.code !== 0) return null;
  return { baseRef: base.trim(), baseSha: probe.stdout.trim() };
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
  return false;
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
  opts?: WorktreeOpts,
): Promise<WorktreeEnsureResult> {
  const gitImpl = opts?.gitImpl ?? git;
  const slug = repoSlugFromPath(repoPath);
  const wt = cursorWorktreeDir(slug, jobId);
  await mkdir(path.dirname(wt), { recursive: true });
  const exists = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
  const listed = exists.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    const p = line.slice("worktree ".length).trim();
    return worktreePathsEqual(p, wt);
  });
  let onDisk = false;
  try {
    await access(wt);
    onDisk = true;
  } catch {
    onDisk = false;
  }
  if (listed && onDisk) {
    const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
    for (const base of bases) {
      const tip = await resolveBaseTip(repoPath, base, gitImpl);
      if (tip) return { path: wt, ...tip };
    }
    if (settings) {
      const resolved = await resolveWorktreeBaseRef(repoPath, settings, gitImpl);
      const tip = await resolveBaseTip(repoPath, resolved.ref, gitImpl);
      if (tip) return { path: wt, ...tip };
    }
    return { path: wt, baseRef: "origin/main", baseSha: "" };
  }
  if (listed && !onDisk) {
    await gitImpl(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(wt, { recursive: true, force: true }).catch(() => undefined);
  }

  await bestEffortFetchOrigin(repoPath, gitImpl);

  const remoteRef = `origin/${branch}`;
  const remoteProbe = await gitImpl(repoPath, ["rev-parse", "--verify", remoteRef]);
  if (remoteProbe.code === 0) {
    const remoteSha = remoteProbe.stdout.trim();
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, remoteRef]);
    if (add.code === 0) {
      const defaultBase = settings
        ? (await resolveWorktreeBaseRef(repoPath, settings, gitImpl)).ref
        : "origin/main";
      const baseTip = await resolveBaseTip(repoPath, defaultBase, gitImpl);
      return {
        path: wt,
        baseRef: baseTip?.baseRef ?? defaultBase,
        baseSha: baseTip?.baseSha ?? remoteSha,
      };
    }
    const remoteAddErr = add.stderr.trim() || add.stdout.trim();
    throw new Error(await enrichWorktreeAddFailure(repoPath, branch, remoteAddErr, opts?.dataDir));
  }

  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  let lastErr = "";
  for (const base of bases) {
    const probe = await gitImpl(repoPath, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    await assertSafeToResetBranchAtBase(repoPath, branch, base, gitImpl);
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, base]);
    if (add.code === 0) {
      const tip = await resolveBaseTip(repoPath, base, gitImpl);
      return { path: wt, ...(tip ?? { baseRef: base, baseSha: probe.stdout.trim() }) };
    }
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  if (settings) {
    const resolved = await resolveWorktreeBaseRef(repoPath, settings, gitImpl);
    await assertSafeToResetBranchAtBase(repoPath, branch, resolved.ref, gitImpl);
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, resolved.ref]);
    if (add.code === 0) {
      const tip = await resolveBaseTip(repoPath, resolved.ref, gitImpl);
      if (tip) return { path: wt, ...tip };
      return { path: wt, baseRef: resolved.ref, baseSha: "" };
    }
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
  opts?: WorktreeOpts,
): Promise<{ path: string; reused: boolean }> {
  const gitImpl = opts?.gitImpl ?? git;
  const slug = repoSlugFromPath(repoPath);
  const expectedWt = cursorWorktreeDir(slug, jobId);
  const wt = existingPath?.trim() || expectedWt;

  const holderPath = parseWorktreePathForBranch(
    (await gitImpl(repoPath, ["worktree", "list", "--porcelain"])).stdout,
    branch,
  );
  if (holderPath) {
    const isOwn =
      (existingPath?.trim() && worktreePathsEqual(holderPath, existingPath)) ||
      worktreePathsEqual(holderPath, expectedWt) ||
      worktreePathsEqual(holderPath, wt);
    if (isOwn) {
      try {
        await access(holderPath);
        return { path: holderPath, reused: true };
      } catch {
        /* recreate below */
      }
    } else {
      throw new Error(
        await enrichWorktreeAddFailure(
          repoPath,
          branch,
          `fatal: '${branch}' is already used by worktree at '${holderPath}'`,
          opts?.dataDir,
        ),
      );
    }
  }

  if (existingPath?.trim()) {
    try {
      await access(existingPath);
      const listed = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
      const onList = listed.stdout.split("\n").some((line) => {
        if (!line.startsWith("worktree ")) return false;
        return worktreePathsEqual(line.slice("worktree ".length).trim(), existingPath);
      });
      if (onList) {
        return { path: existingPath, reused: true };
      }
    } catch {
      /* recreate below */
    }
  }
  const listed = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
  const onList = listed.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return worktreePathsEqual(line.slice("worktree ".length).trim(), wt);
  });
  if (onList) {
    try {
      await access(wt);
      return { path: wt, reused: true };
    } catch {
      await gitImpl(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
      await rm(wt, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await mkdir(path.dirname(wt), { recursive: true });
  await bestEffortFetchOrigin(repoPath, gitImpl);
  const remoteRef = `origin/${branch}`;
  const probe = await gitImpl(repoPath, ["rev-parse", "--verify", remoteRef]);
  if (probe.code === 0) {
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, remoteRef]);
    if (add.code === 0) return { path: wt, reused: false };
    throw new Error(
      await enrichWorktreeAddFailure(
        repoPath,
        branch,
        add.stderr.trim() || add.stdout.trim(),
        opts?.dataDir,
      ),
    );
  }
  const pathFromEnsure = await ensureWorktree(repoPath, jobId, branch, settings, opts);
  return { path: pathFromEnsure.path, reused: false };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { branch?: string; deleteBranch?: boolean; gitImpl?: GitFn },
): Promise<void> {
  const gitImpl = opts?.gitImpl ?? git;
  await gitImpl(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  if (opts?.deleteBranch && opts.branch?.trim()) {
    await deleteLocalBranch(repoPath, opts.branch, gitImpl);
  }
}

export type GitOperationInProgress = "rebase" | "merge" | "cherry-pick";

/** Detect an unfinished rebase, merge, or cherry-pick before handing the worktree to an agent. */
export async function detectGitOperationInProgress(
  worktree: string,
  gitImpl: GitFn = git,
): Promise<GitOperationInProgress | null> {
  const checks: Array<{ ref: string; op: GitOperationInProgress }> = [
    { ref: "REBASE_HEAD", op: "rebase" },
    { ref: "MERGE_HEAD", op: "merge" },
    { ref: "CHERRY_PICK_HEAD", op: "cherry-pick" },
  ];
  for (const { ref, op } of checks) {
    const probe = await gitImpl(worktree, ["rev-parse", "-q", "--verify", ref]);
    if (probe.code === 0) return op;
  }
  return null;
}

export async function abortGitOperationInProgress(
  worktree: string,
  op: GitOperationInProgress,
  gitImpl: GitFn = git,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cmd =
    op === "rebase"
      ? ["rebase", "--abort"]
      : op === "merge"
        ? ["merge", "--abort"]
        : ["cherry-pick", "--abort"];
  const res = await gitImpl(worktree, cmd);
  if (res.code === 0) return { ok: true };
  const err = res.stderr.trim() || res.stdout.trim() || `git ${cmd.join(" ")} failed`;
  return { ok: false, error: err };
}

/** Update the branch tip onto the default base with merge (not rebase) so a normal push works. */
export async function mergeOntoBase(worktree: string, settings?: RunnerSettings): Promise<void> {
  await git(worktree, ["fetch", "origin"]);
  const order = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  for (const base of order) {
    const probe = await git(worktree, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    const baseSha = probe.stdout.trim();
    const contains = await git(worktree, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
    if (contains.code === 0) return;
    const mg = await git(worktree, ["merge", "--no-edit", base]);
    if (mg.code !== 0) {
      throw new Error(`git merge ${base} failed: ${mg.stderr.trim()}`);
    }
    return;
  }
  throw new Error("Could not find origin/main or origin/master for merge");
}

/** @deprecated Use mergeOntoBase — rebasing rewrites pushed history. */
export async function rebaseOntoBase(worktree: string, settings?: RunnerSettings): Promise<void> {
  return mergeOntoBase(worktree, settings);
}
