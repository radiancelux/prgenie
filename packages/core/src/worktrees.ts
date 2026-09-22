import { realpathSync, statSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { findGitRoot, git, gitText } from "./git.js";
import type { WorktreeInfo } from "./types.js";

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { stdout } = await git(cwd, ["worktree", "list", "--porcelain"]);
  const blocks = stdout
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
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

export function worktreeForBranch(trees: WorktreeInfo[], branch: string): string | null {
  const match = trees.find((t) => t.branch === branch);
  return match?.path ?? null;
}

/** Checkout for this loop id only — exclusive `.loops/<id>`, never the primary folder. */
export function worktreeForLoop(
  trees: WorktreeInfo[],
  loop: { id: string; headRef: string },
): string | null {
  const primary = primaryWorktreePath(trees);
  const dest = primary ? loopWorktreeDir(primary, loop.id) : null;
  if (dest) {
    const own = trees.find((t) => sameFsPath(t.path, dest));
    if (own) return own.path;
  }
  const onBranch = trees.filter((t) => t.branch === loop.headRef);
  const ownLoops = onBranch.find((t) => {
    const ident = loopWorktreeIdentity(t.path);
    return ident && ident.id.toLowerCase() === loop.id.toLowerCase();
  });
  return ownLoops?.path ?? null;
}

/**
 * Refuse binding a loop to the primary checkout while another non-archived loop is live.
 * Exclusive `.loops/<id>` is the default; this is the clear error when a bind would still land on primary.
 */
export function refusePrimaryWorktreeIfParallel(
  worktreePath: string,
  primary: string,
  loopId: string,
  liveLoopIds: Iterable<string>,
): void {
  const others = [...liveLoopIds]
    .map((id) => id.toLowerCase())
    .filter((id) => id !== loopId.toLowerCase());
  if (others.length === 0) return;
  if (!sameFsPath(worktreePath, primary)) return;
  throw new Error(
    `Refusing to bind loop ${loopId} to the primary checkout while other live loops exist (${others.join(", ")}). Every live loop must use an exclusive ../<repo>.loops/<id> worktree.`,
  );
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
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
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

export function refsAreSameBranch(a: string, b: string): boolean {
  return localBaseRef(a).toLowerCase() === localBaseRef(b).toLowerCase();
}

/** True when `head` is missing, detached, or the same branch as the loop base (main/master). */
export function isBaseBranch(head: string | null | undefined, baseRef: string): boolean {
  if (!head || head === "HEAD" || head === "DETACHED") return true;
  return refsAreSameBranch(head, baseRef);
}

async function branchExists(cwd: string, name: string): Promise<boolean> {
  const ref = localBaseRef(name);
  const result = await git(cwd, ["rev-parse", "--verify", `refs/heads/${ref}`], {
    allowFail: true,
  });
  return result.code === 0;
}

/**
 * Pick (or create) a feature branch this loop can export.
 * Never uses the loop base. If this checkout is on the base, create `<id>` without switching
 * the primary tree onto it (exclusive `.loops/<id>` worktrees own the checkout).
 * If the requested head is already checked out elsewhere, create `<id>` from that commit instead.
 */
export async function ensureLoopFeatureBranch(
  cwd: string,
  options: { id: string; requestedHead?: string | null; baseRef: string },
): Promise<{ headRef: string; headSha: string }> {
  const current = await currentBranch(cwd);
  const wanted = options.requestedHead?.trim() || current;
  const here = await findGitRoot(cwd);
  const trees = await listWorktrees(cwd);

  if (wanted && !isBaseBranch(wanted, options.baseRef)) {
    const holder = trees.find((t) => t.branch === wanted);
    if (!holder || (here && sameFsPath(holder.path, here))) {
      return {
        headRef: wanted,
        headSha: await gitText(cwd, ["rev-parse", wanted]),
      };
    }
    const headRef = options.id;
    const headSha = await gitText(cwd, ["rev-parse", wanted]);
    const created = await git(cwd, ["branch", headRef, wanted], { allowFail: true });
    if (created.code !== 0 && !(await branchExists(cwd, headRef))) {
      throw new Error(`Could not create loop branch ${headRef}: ${created.stderr.trim()}`);
    }
    return { headRef, headSha };
  }

  const headRef = options.id;
  if (here && isBaseBranch(current, options.baseRef)) {
    const created = await git(cwd, ["branch", headRef], { allowFail: true });
    if (created.code !== 0 && !(await branchExists(cwd, headRef))) {
      throw new Error(`Could not create loop branch ${headRef}: ${created.stderr.trim()}`);
    }
    return { headRef, headSha: await gitText(cwd, ["rev-parse", headRef]) };
  }

  const created = await git(cwd, ["branch", headRef], { allowFail: true });
  if (created.code !== 0 && !(await branchExists(cwd, headRef))) {
    throw new Error(`Could not create loop branch ${headRef}: ${created.stderr.trim()}`);
  }
  return { headRef, headSha: await gitText(cwd, ["rev-parse", "HEAD"]) };
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

/**
 * Remove every sibling `.loops/<id>` worktree for this repo (force).
 * Tests should call this in `beforeEach` so leftover exclusive checkouts do not poison later cases.
 */
export async function pruneLoopWorktrees(cwd: string): Promise<void> {
  const trees = await listWorktrees(cwd);
  for (const t of trees) {
    if (!loopWorktreeIdentity(t.path)) continue;
    await git(cwd, ["worktree", "remove", "--force", "--", t.path], { allowFail: true });
  }
  await git(cwd, ["worktree", "prune"], { allowFail: true });
}

/** Drop a sibling .loops checkout after export. Never remove the primary repo folder. */
export async function pruneArchivedLoopWorktree(
  cwd: string,
  loop: { id: string; worktreePath: string | null },
  options: { keepPaths?: string[] } = {},
): Promise<boolean> {
  const trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  if (!primary) return false;
  const dest = loopWorktreeDir(primary, loop.id);
  const extra = trees.find((t) => sameFsPath(t.path, dest));
  if (!extra) return false;
  const ident = loopWorktreeIdentity(extra.path);
  if (ident && ident.id.toLowerCase() !== loop.id.toLowerCase()) return false;
  const here = await findGitRoot(cwd);
  if (here && sameFsPath(here, extra.path)) return false;
  if (sameFsPath(extra.path, primary)) return false;
  const keep = options.keepPaths ?? [];
  if (keep.some((p) => sameFsPath(p, extra.path))) return false;
  const otherLoops = trees.filter((t) => {
    const other = loopWorktreeIdentity(t.path);
    return other && other.id.toLowerCase() !== loop.id.toLowerCase();
  });
  if (otherLoops.some((t) => sameFsPath(t.path, extra.path))) return false;
  const removed = await git(cwd, ["worktree", "remove", extra.path], { allowFail: true });
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
  const keepPaths = trees
    .filter((t) => {
      const ident = loopWorktreeIdentity(t.path);
      return ident && ident.id.toLowerCase() !== loop.id.toLowerCase();
    })
    .map((t) => t.path);
  const prunedWorktree = await pruneArchivedLoopWorktree(cwd, loop, { keepPaths });
  const here = await findGitRoot(cwd);
  const dest = primary ? loopWorktreeDir(primary, loop.id) : null;
  const stillExtra = dest
    ? (await listWorktrees(cwd)).some((t) => sameFsPath(t.path, dest))
    : false;
  const reopen = Boolean(stillExtra && here && dest && sameFsPath(here, dest));
  return { checkedOutBase, prunedWorktree, primaryPath: primary, reopen };
}

async function freeStaleLoopWorktree(cwd: string, treePath: string): Promise<void> {
  const here = await findGitRoot(cwd);
  if (here && sameFsPath(here, treePath)) {
    await git(treePath, ["checkout", "--detach"], { allowFail: true });
    return;
  }
  await git(cwd, ["worktree", "remove", treePath], { allowFail: true });
  await git(cwd, ["worktree", "prune"], { allowFail: true });
}

export function peelStashMessage(loopId: string): string {
  return `prgenie-exclusive-peel-${loopId}`;
}

/** Resolve `stash@{N}` whose message matches this loop's peel stash — never assume stash@{0}. */
export async function findPeelStashRef(cwd: string, loopId: string): Promise<string | null> {
  const list = await git(cwd, ["stash", "list"], { allowFail: true });
  if (list.code !== 0) return null;
  const needle = peelStashMessage(loopId);
  for (const line of list.stdout.split("\n")) {
    const text = line.replace(/\r$/, "").trim();
    if (!text.includes(needle)) continue;
    const match = text.match(/^(stash@\{\d+\})/);
    if (match) return match[1];
  }
  return null;
}

async function freePrimaryFromLoopBranch(
  primary: string,
  loop: { id: string; headRef: string; baseRef?: string },
): Promise<boolean> {
  const branch = await currentBranch(primary);
  if (branch !== loop.headRef) return false;
  let stashed = false;
  const status = await git(primary, ["status", "--porcelain"], { allowFail: true });
  if (status.stdout.trim()) {
    const stash = await git(primary, ["stash", "push", "-u", "-m", peelStashMessage(loop.id)], {
      allowFail: true,
    });
    if (stash.code !== 0) {
      throw new Error(
        `Cannot free primary checkout from branch ${loop.headRef} to create an exclusive loop worktree: ${stash.stderr.trim() || "stash failed"}. Commit or stash changes in the primary folder, then retry.`,
      );
    }
    stashed = true;
  }
  const base = loop.baseRef ? localBaseRef(loop.baseRef) : null;
  if (base && base !== loop.headRef) {
    const switched = await git(primary, ["checkout", base], { allowFail: true });
    if (switched.code === 0) return stashed;
  }
  const detached = await git(primary, ["checkout", "--detach"], { allowFail: true });
  if (detached.code === 0) return stashed;
  throw new Error(
    `Cannot free primary checkout from branch ${loop.headRef} to create an exclusive loop worktree. Commit or stash changes in the primary folder, then retry.`,
  );
}

async function restorePeelStash(dest: string, loopId: string): Promise<void> {
  const ref = await findPeelStashRef(dest, loopId);
  if (!ref) return;
  await git(dest, ["stash", "pop", ref], { allowFail: true });
}

async function addLoopWorktree(
  cwd: string,
  dest: string,
  loop: { id: string; headRef: string; headSha: string },
): Promise<string> {
  if (existsSync(dest)) {
    const already = await findGitRoot(dest);
    if (already) return dest;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await git(cwd, ["worktree", "prune"], { allowFail: true });
  const trees = await listWorktrees(cwd);
  const held = trees.some((t) => t.branch === loop.headRef);
  if (!held && (await branchExists(cwd, loop.headRef))) {
    const added = await git(cwd, ["worktree", "add", dest, loop.headRef], { allowFail: true });
    if (added.code === 0) return dest;
  }
  if (!held && !(await branchExists(cwd, loop.headRef))) {
    const created = await git(cwd, ["worktree", "add", "-b", loop.headRef, dest, loop.headSha], {
      allowFail: true,
    });
    if (created.code === 0) return dest;
    throw new Error(
      `Could not create a worktree for loop ${loop.id} on branch ${loop.headRef}: ${created.stderr.trim()}`,
    );
  }
  throw new Error(
    `Could not create a worktree for loop ${loop.id}: branch ${loop.headRef} is already checked out.`,
  );
}

/** One exclusive git worktree per loop at `../<repo>.loops/<id>` — never the primary folder. */
export async function ensureWorktreeForLoop(
  cwd: string,
  loop: { id: string; headRef: string; headSha: string; baseRef?: string },
  options: { staleLoopIds?: Iterable<string>; liveLoopIds?: Iterable<string> } = {},
): Promise<string> {
  const stale = new Set([...(options.staleLoopIds ?? [])].map((id) => id.toLowerCase()));
  const live = new Set([...(options.liveLoopIds ?? [])].map((id) => id.toLowerCase()));
  live.add(loop.id.toLowerCase());
  let trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  if (!primary) throw new Error("No git worktree to attach a loop to.");
  const dest = loopWorktreeDir(primary, loop.id);
  const own = trees.find((t) => sameFsPath(t.path, dest));
  if (own) {
    refusePrimaryWorktreeIfParallel(own.path, primary, loop.id, live);
    return own.path;
  }

  let peelStashed = false;
  let stashRestored = false;
  try {
    const holders = trees.filter((t) => t.branch === loop.headRef);
    for (const holder of holders) {
      if (sameFsPath(holder.path, dest)) {
        refusePrimaryWorktreeIfParallel(holder.path, primary, loop.id, live);
        return holder.path;
      }
      if (sameFsPath(holder.path, primary)) {
        peelStashed = (await freePrimaryFromLoopBranch(primary, loop)) || peelStashed;
        continue;
      }
      const ident = loopWorktreeIdentity(holder.path);
      if (ident && ident.id.toLowerCase() === loop.id.toLowerCase()) {
        refusePrimaryWorktreeIfParallel(holder.path, primary, loop.id, live);
        return holder.path;
      }
      if (ident) {
        const otherId = ident.id.toLowerCase();
        if (live.has(otherId) && !stale.has(otherId)) continue;
        await freeStaleLoopWorktree(cwd, holder.path);
      }
    }

    trees = await listWorktrees(cwd);
    const stillOwn = trees.find((t) => sameFsPath(t.path, dest));
    if (stillOwn) {
      refusePrimaryWorktreeIfParallel(stillOwn.path, primary, loop.id, live);
      return stillOwn.path;
    }
    if (trees.some((t) => t.branch === loop.headRef && sameFsPath(t.path, primary))) {
      peelStashed = (await freePrimaryFromLoopBranch(primary, loop)) || peelStashed;
    }
    const exclusive = await addLoopWorktree(cwd, dest, loop);
    if (peelStashed) {
      await restorePeelStash(exclusive, loop.id);
      stashRestored = true;
    }
    refusePrimaryWorktreeIfParallel(exclusive, primary, loop.id, live);
    return exclusive;
  } finally {
    // If peel stashed dirty work and we never restored into the exclusive tree
    // (addLoopWorktree failed, early throw, etc.), put it back on primary.
    if (peelStashed && !stashRestored) {
      await restorePeelStash(primary, loop.id);
    }
  }
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
