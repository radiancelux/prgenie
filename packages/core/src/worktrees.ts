import path from "node:path";
import { git, gitText } from "./git.js";
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
      if (line.startsWith("worktree ")) info.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) info.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        info.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") info.bare = true;
      else if (line === "detached") info.detached = true;
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
