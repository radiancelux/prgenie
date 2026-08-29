import { realpathSync, statSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { findGitRoot, git, gitText } from "./git.js";
import type { WorktreeInfo } from "./types.js";

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { stdout } = await git(cwd, ["worktree", "list", "--porcelain"]);
  const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const trees: WorktreeInfo[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const info: WorktreeInfo = {
      path: "",
      head: "",
      branch: null,
      bare: false,
      detached: false,
    };
    for (const line of lines) {
      const text = line.replace(/\r$/, "");
      if (text.startsWith("worktree ")) info.path = text.slice("worktree ".length);
      else if (text.startsWith("HEAD ")) info.head = text.slice("HEAD ".length);
      else if (text.startsWith("branch ")) {
        const ref = text.slice("branch ".length);
        info.branch = ref.replace(/^refs\/heads\//, "");
      } else if (text === "bare") info.bare = true;
      else if (text === "detached") info.detached = true;
    }
    if (info.path) trees.push(info);
  }
  return trees;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["branch", "--show-current"], { allowFail: true });
  if (result.code !== 0) return null;
  const name = result.stdout.trim();
  return name || null;
}

export async function detectDefaultBase(cwd: string): Promise<string> {
  const originHead = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    allowFail: true,
  });
  if (originHead.code === 0) {
    return originHead.stdout.trim().replace(/^refs\/remotes\//, "");
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = await git(cwd, ["rev-parse", "--verify", candidate], {
      allowFail: true,
    });
    if (probe.code === 0) return candidate;
  }
  return "HEAD";
}

export function worktreeForBranch(
  trees: WorktreeInfo[],
  branch: string,
): string | null {
  const match = trees.find((t) => t.branch === branch);
  return match?.path ?? null;
}

export function sameFsPath(a: string, b: string): boolean {
  try {
    const leftStat = statSync(a);
    const rightStat = statSync(b);
    if (leftStat.ino !== 0 && leftStat.ino === rightStat.ino && leftStat.dev === rightStat.dev) {
      return true;
    }
  } catch {
    // path missing
  }
  const canon = (p: string): string => {
    const normalized = path.resolve(p);
    try {
      return realpathSync.native(normalized);
    } catch {
      try {
        return realpathSync(normalized);
      } catch {
        return normalized;
      }
    }
  };
  const left = canon(a);
  const right = canon(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function loopWorktreeDir(mainPath: string, id: string): string {
  return path.join(path.dirname(mainPath), `${path.basename(mainPath)}.loops`, id);
}

/** `../<repo>.loops/<id>` → the primary repo folder and loop id. */
export function loopWorktreeIdentity(absPath: string): { primaryPath: string; id: string } | null {
  const resolved = path.resolve(absPath);
  const parent = path.dirname(resolved);
  const loopsDir = path.basename(parent);
  if (!loopsDir.endsWith(".loops")) return null;
  const id = path.basename(resolved);
  if (!/^lp-[0-9a-f]{8}$/i.test(id)) return null;
  return {
    primaryPath: path.join(path.dirname(parent), loopsDir.slice(0, -".loops".length)),
    id,
  };
}

export function localBaseRef(baseRef: string): string {
  return baseRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

export function primaryWorktreePath(trees: WorktreeInfo[]): string | null {
  const mains = trees.filter((t) => !t.bare && !loopWorktreeIdentity(t.path));
  return mains[0]?.path ?? trees.find((t) => !t.bare)?.path ?? null;
}

export type ReleaseArchivedLoopResult = {
  checkedOutBase: boolean;
  prunedWorktree: boolean;
  primaryPath: string | null;
  /** This window is still the extra loop checkout; reopen primaryPath then prune. */
  reopen: boolean;
};

async function checkoutPrimaryOffLoop(
  primary: string,
  loop: { headRef: string; baseRef: string },
): Promise<boolean> {
  const base = localBaseRef(loop.baseRef);
  if (!base || base === loop.headRef) return false;
  const branch = await currentBranch(primary);
  if (branch !== loop.headRef) return false;
  const switched = await git(primary, ["checkout", base], { allowFail: true });
  return switched.code === 0;
}

/** Drop a sibling .loops checkout after export. Never remove the primary repo folder. */
export async function pruneArchivedLoopWorktree(
  cwd: string,
  loop: { id: string; worktreePath: string | null },
): Promise<boolean> {
  const trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  if (!primary) return false;
  const dest = loopWorktreeDir(primary, loop.id);
  const extra = trees.find((t) => sameFsPath(t.path, dest));
  if (!extra) return false;
  const here = await findGitRoot(cwd);
  if (here && sameFsPath(here, extra.path)) return false;
  if (sameFsPath(extra.path, primary)) return false;
  let removed = await git(cwd, ["worktree", "remove", extra.path], { allowFail: true });
  if (removed.code !== 0) {
    removed = await git(cwd, ["worktree", "remove", "--force", extra.path], { allowFail: true });
  }
  if (removed.code !== 0) return false;
  await git(cwd, ["worktree", "prune"], { allowFail: true });
  return true;
}

/** After export: take the loop branch off the main workspace and remove the extra worktree. */
export async function releaseArchivedLoop(
  cwd: string,
  loop: { id: string; headRef: string; baseRef: string; worktreePath: string | null },
): Promise<ReleaseArchivedLoopResult> {
  const trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  const checkedOutBase = primary ? await checkoutPrimaryOffLoop(primary, loop) : false;
  const prunedWorktree = await pruneArchivedLoopWorktree(cwd, loop);
  const here = await findGitRoot(cwd);
  const dest = primary ? loopWorktreeDir(primary, loop.id) : null;
  const stillExtra = dest
    ? (await listWorktrees(cwd)).some((t) => sameFsPath(t.path, dest))
    : false;
  const reopen = Boolean(
    stillExtra && here && dest && sameFsPath(here, dest),
  );
  return { checkedOutBase, prunedWorktree, primaryPath: primary, reopen };
}

/** One git worktree per loop branch so the developer can switch this window onto the implementor's files. */
export async function ensureWorktreeForLoop(
  cwd: string,
  loop: { id: string; headRef: string; headSha: string },
): Promise<string> {
  const trees = await listWorktrees(cwd);
  const existing = worktreeForBranch(trees, loop.headRef);
  if (existing) return existing;
  const current = await currentBranch(cwd);
  if (current === loop.headRef) {
    const here = await findGitRoot(cwd);
    if (here) return here;
  }

  const main = trees.find((t) => !t.bare)?.path;
  if (!main) throw new Error("No git worktree to attach a loop to.");
  const dest = loopWorktreeDir(main, loop.id);
  if (existsSync(dest)) {
    const already = await findGitRoot(dest);
    if (already) return dest;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await git(cwd, ["worktree", "prune"], { allowFail: true });
  const branched = await git(cwd, ["worktree", "add", dest, loop.headRef], {
    allowFail: true,
  });
  if (branched.code === 0) return dest;
  const detached = await git(cwd, ["worktree", "add", "--detach", dest, loop.headSha], {
    allowFail: true,
  });
  if (detached.code === 0) return dest;
  throw new Error(
    `Could not create a worktree for loop ${loop.id} (${loop.headRef}): ${(branched.stderr || detached.stderr).trim()}`,
  );
}

export function displayPath(repoRoot: string, absPath: string | null): string | null {
  if (!absPath) return null;
  const rel = path.relative(repoRoot, absPath);
  return rel && !rel.startsWith("..") ? rel : absPath;
}

export async function userName(cwd: string): Promise<string> {
  const result = await git(cwd, ["config", "user.name"], { allowFail: true });
  return result.stdout.trim() || "local";
}

export async function shortLogSubject(cwd: string, rev = "HEAD"): Promise<string> {
  return gitText(cwd, ["log", "-1", "--format=%s", rev]);
}
