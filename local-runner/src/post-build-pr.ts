import type { GhResult } from "./spawn-cmd.js";
import type { PrInfo } from "./github.js";
import { ghWithGithubRetry, isTransientGithubFailure } from "./github-rate-limit.js";
import { resolveRepoSlug, restCreateDraftPull, restFindOpenPrForBranch } from "./github-rest.js";

export type GitGh = {
  git: (cwd: string, args: string[]) => Promise<GhResult>;
  gh: (cwd: string, args: string[]) => Promise<GhResult>;
};

export async function workingTreeDirty(cwd: string, git: GitGh["git"]): Promise<boolean> {
  const st = await git(cwd, ["status", "--porcelain"]);
  if (st.code !== 0) return false;
  return st.stdout.trim().length > 0;
}

export async function commitAllIfDirty(
  cwd: string,
  message: string,
  git: GitGh["git"],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await workingTreeDirty(cwd, git))) return { ok: true };
  const add = await git(cwd, ["add", "-A"]);
  if (add.code !== 0) {
    return { ok: false, error: add.stderr.trim() || "git add failed" };
  }
  const commit = await git(cwd, ["commit", "-m", message]);
  if (commit.code !== 0) {
    const out = `${commit.stderr}\n${commit.stdout}`.trim();
    if (/nothing to commit/i.test(out)) return { ok: true };
    return { ok: false, error: out || "git commit failed" };
  }
  return { ok: true };
}

export async function pushBranch(
  cwd: string,
  branch: string,
  git: GitGh["git"],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sync = await git(cwd, ["rev-parse", "HEAD"]);
  if (sync.code !== 0) return { ok: false, error: "could not resolve HEAD" };
  const remote = await git(cwd, ["rev-parse", `refs/remotes/origin/${branch}`]);
  if (remote.code === 0 && remote.stdout.trim() === sync.stdout.trim()) {
    return { ok: true };
  }
  const push = await git(cwd, ["push", "-u", "origin", branch]);
  if (push.code !== 0) {
    return { ok: false, error: push.stderr.trim() || push.stdout.trim() || "git push failed" };
  }
  return { ok: true };
}

async function resolveDefaultBaseBranch(cwd: string, gh: GitGh["gh"]): Promise<string> {
  const res = await ghWithGithubRetry(
    cwd,
    ["api", "repos/{owner}/{repo}", "--jq", ".default_branch"],
    gh,
  );
  if (res.code === 0) {
    const base = res.stdout.trim();
    if (base) return base;
  }
  return "main";
}

export type CreateDraftPrOptions = {
  repoSlug?: string | null;
  prUrl?: string | null;
};

export async function createDraftPr(
  cwd: string,
  branch: string,
  title: string,
  gh: GitGh["gh"],
  options: CreateDraftPrOptions = {},
): Promise<{ ok: true; pr: PrInfo } | { ok: false; error: string; transient?: boolean }> {
  const repoSlug = resolveRepoSlug(options.repoSlug, options.prUrl);
  const existing = await restFindOpenPrForBranch(cwd, branch, repoSlug, gh);
  if (existing) return { ok: true, pr: existing };

  const base = await resolveDefaultBaseBranch(cwd, gh);
  const created = await restCreateDraftPull(cwd, branch, title, base, repoSlug, gh);
  if (created.ok) return created;

  if (!created.ok && created.transient) {
    const again = await restFindOpenPrForBranch(cwd, branch, repoSlug, gh);
    if (again) return { ok: true, pr: again };
  }
  return created;
}

export type EnsureDraftPrInput = {
  cwd: string;
  branch: string;
  title: string;
  repoSlug?: string | null;
  prUrl?: string | null;
};

/**
 * After build: commit local changes, push the branch, and open a draft PR when the agent left
 * work on the branch but did not open a PR (#198).
 */
export async function ensureDraftPrAfterBuild(
  input: EnsureDraftPrInput,
  deps: GitGh,
): Promise<{ ok: true; pr: PrInfo } | { ok: false; error: string; transient?: boolean }> {
  const commitMsg = input.title?.trim() || `Updates for ${input.branch}`;
  const committed = await commitAllIfDirty(input.cwd, commitMsg, deps.git);
  if (!committed.ok) return committed;
  const pushed = await pushBranch(input.cwd, input.branch, deps.git);
  if (!pushed.ok) return pushed;
  return createDraftPr(input.cwd, input.branch, commitMsg, deps.gh, {
    repoSlug: input.repoSlug,
    prUrl: input.prUrl,
  });
}

/** True when callers should not mark the job stuck (GitHub throttling). */
export function isEnsurePrTransientFailure(
  result: { ok: false; error: string; transient?: boolean },
  rawGh?: GhResult,
): boolean {
  if (result.transient) return true;
  if (rawGh && isTransientGithubFailure(rawGh)) return true;
  return /rate limit|secondary rate/i.test(result.error);
}
