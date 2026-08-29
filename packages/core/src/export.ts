import { git } from "./git.js";
import { ensureRepoGithub, runGh } from "./github-ops.js";
import { getLocalPr, isArchivedPr, listLocalPrs, setLocalPrStatus } from "./prs.js";
import { localBaseRef, releaseArchivedLoop } from "./worktrees.js";
import { haltWatch, resumeWatch } from "./watch.js";

function ghBase(ref: string): string {
  return ref.replace(/^origin\//, "").replace(/^refs\/heads\//, "");
}

export type GithubPrHeadState = "MERGED" | "OPEN" | "CLOSED" | null;

export function githubPrViewArgs(
  headRef: string,
  options: { json: string; jq?: string },
): string[] {
  const args = ["pr", "view", localBaseRef(headRef), "--json", options.json];
  if (options.jq) args.push("-q", options.jq);
  return args;
}

export async function githubPrStateForHead(
  cwd: string,
  headRef: string,
): Promise<GithubPrHeadState> {
  const result = await runGh(githubPrViewArgs(headRef, { json: "state" }), { cwd });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { state?: string };
    const state = parsed.state?.toUpperCase();
    if (state === "MERGED" || state === "OPEN" || state === "CLOSED") return state;
  } catch {
    // ignore malformed gh output
  }
  return null;
}

/** Archive live loops whose GitHub PR is already merged. Does not un-archive. */
export async function archiveLoopsMergedOnGithub(
  cwd: string,
  lookup: (headRef: string) => Promise<GithubPrHeadState> = (head) =>
    githubPrStateForHead(cwd, head),
): Promise<string[]> {
  const ids: string[] = [];
  const prs = await listLocalPrs(cwd);
  for (const pr of prs) {
    if (isArchivedPr(pr)) continue;
    let state: GithubPrHeadState = null;
    try {
      state = await lookup(pr.headRef);
    } catch {
      continue;
    }
    if (state !== "MERGED") continue;
    await setLocalPrStatus(cwd, pr.id, "approved");
    const archived = await getLocalPr(cwd, pr.id);
    await releaseArchivedLoop(cwd, archived);
    ids.push(pr.id);
  }
  return ids;
}

/** Push this loop's recorded SHA, not whatever HEAD is in cwd. */
export function exportPushRefspec(pr: { headSha: string; headRef: string }): string {
  return `${pr.headSha}:refs/heads/${pr.headRef}`;
}

export async function exportLocalPr(
  cwd: string,
  id: string,
): Promise<{
  url: string;
  id: string;
  alreadyExisted: boolean;
  checkedOutBase: boolean;
  prunedWorktree: boolean;
  primaryPath: string | null;
  reopen: boolean;
}> {
  const pr = await getLocalPr(cwd, id);
  const ghState = await ensureRepoGithub(cwd);
  if (!ghState.bound && !ghState.login) {
    throw new Error("No GitHub account. Run: gh auth login, then prgenie gh use <login>");
  }
  if (!ghState.bound) {
    throw new Error(
      `This repo is not bound to a GitHub login. Ask which account, then prgenie gh use <login> (active is ${ghState.login}).`,
    );
  }

  await haltWatch(cwd, "export", pr.id);
  try {
    const push = await git(cwd, ["push", "-u", "origin", exportPushRefspec(pr)], {
      allowFail: true,
    });
    if (push.code !== 0) {
      throw new Error(push.stderr.trim() || `git push failed for ${pr.headRef}`);
    }

    const existing = await runGh(
      githubPrViewArgs(pr.headRef, { json: "url", jq: ".url" }),
      { cwd },
    );
    let url: string;
    let alreadyExisted = false;
    if (existing.code === 0 && existing.stdout.trim().startsWith("http")) {
      url = existing.stdout.trim();
      alreadyExisted = true;
    } else {
      const created = await runGh(
        [
          "pr",
          "create",
          "--title",
          pr.title,
          "--body",
          pr.body.trim() || pr.title,
          "--base",
          ghBase(pr.baseRef),
          "--head",
          pr.headRef,
        ],
        { cwd },
      );
      if (created.code !== 0) {
        throw new Error(created.stderr.trim() || created.stdout.trim() || "gh pr create failed");
      }
      url =
        created.stdout.trim().split("\n").find((line) => /^https?:\/\//.test(line)) ??
        created.stdout.trim();
      if (!url) throw new Error("gh pr create succeeded but returned no URL");
    }

    if (pr.status !== "approved") {
      await setLocalPrStatus(cwd, pr.id, "approved");
    }
    const archived = await getLocalPr(cwd, pr.id);
    const released = await releaseArchivedLoop(cwd, archived);
    return { url, id: pr.id, alreadyExisted, ...released };
  } catch (err) {
    await resumeWatch(cwd);
    throw err;
  }
}
