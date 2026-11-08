import type { GhResult } from "./spawn-cmd.js";
import type { PrInfo } from "./github.js";

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

function parsePrCreate(stdout: string, stderr: string): PrInfo | null {
  const text = `${stdout}\n${stderr}`;
  const urlMatch = text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/i);
  if (!urlMatch) return null;
  return { url: urlMatch[0].replace(/[).,]+$/, ""), number: Number(urlMatch[1]) };
}

export async function createDraftPr(
  cwd: string,
  branch: string,
  title: string,
  gh: GitGh["gh"],
): Promise<{ ok: true; pr: PrInfo } | { ok: false; error: string }> {
  const args = ["pr", "create", "--draft", "--head", branch, "--title", title, "--body", title];
  const res = await gh(cwd, args);
  const pr = parsePrCreate(res.stdout, res.stderr);
  if (res.code === 0 && pr) return { ok: true, pr };
  const err = res.stderr.trim() || res.stdout.trim() || "gh pr create failed";
  if (/already exists/i.test(err)) {
    const view = await gh(cwd, ["pr", "view", branch, "--json", "url,number"]);
    if (view.code === 0) {
      try {
        const parsed = JSON.parse(view.stdout) as { url?: string; number?: number };
        if (parsed.url && typeof parsed.number === "number") {
          return { ok: true, pr: { url: parsed.url, number: parsed.number } };
        }
      } catch {
        // fall through
      }
    }
  }
  return { ok: false, error: err.slice(0, 400) };
}

export type EnsureDraftPrInput = {
  cwd: string;
  branch: string;
  title: string;
};

/**
 * After build: commit local changes, push the branch, and open a draft PR when the agent left
 * work on the branch but did not open a PR (#198).
 */
export async function ensureDraftPrAfterBuild(
  input: EnsureDraftPrInput,
  deps: GitGh,
): Promise<{ ok: true; pr: PrInfo } | { ok: false; error: string }> {
  const commitMsg = input.title?.trim() || `Updates for ${input.branch}`;
  const committed = await commitAllIfDirty(input.cwd, commitMsg, deps.git);
  if (!committed.ok) return committed;
  const pushed = await pushBranch(input.cwd, input.branch, deps.git);
  if (!pushed.ok) return pushed;
  return createDraftPr(input.cwd, input.branch, commitMsg, deps.gh);
}
