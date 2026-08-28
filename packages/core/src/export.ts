import { git } from "./git.js";
import { ensureRepoGithub, runGh } from "./github-ops.js";
import { getLocalPr, setLocalPrStatus } from "./prs.js";
import { haltWatch } from "./watch.js";

function ghBase(ref: string): string {
  return ref.replace(/^origin\//, "").replace(/^refs\/heads\//, "");
}

export async function exportLocalPr(
  cwd: string,
  id: string,
): Promise<{ url: string; id: string; alreadyExisted: boolean }> {
  const pr = await getLocalPr(cwd, id);
  await haltWatch(cwd, "export", pr.id);
  if (pr.status !== "approved") {
    await setLocalPrStatus(cwd, pr.id, "approved");
  }

  const ghState = await ensureRepoGithub(cwd);
  if (!ghState.bound && !ghState.login) {
    throw new Error("No GitHub account. Run: gh auth login, then prgenie gh use <login>");
  }
  if (!ghState.bound) {
    throw new Error(
      `This repo is not bound to a GitHub login. Ask which account, then prgenie gh use <login> (active is ${ghState.login}).`,
    );
  }

  const push = await git(cwd, ["push", "-u", "origin", `HEAD:refs/heads/${pr.headRef}`], {
    allowFail: true,
  });
  if (push.code !== 0) {
    throw new Error(push.stderr.trim() || `git push failed for ${pr.headRef}`);
  }

  const existing = await runGh(
    ["pr", "view", "--head", pr.headRef, "--json", "url", "-q", ".url"],
    { cwd },
  );
  if (existing.code === 0 && existing.stdout.trim().startsWith("http")) {
    return { url: existing.stdout.trim(), id: pr.id, alreadyExisted: true };
  }

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
  const url =
    created.stdout.trim().split("\n").find((line) => /^https?:\/\//.test(line)) ??
    created.stdout.trim();
  if (!url) throw new Error("gh pr create succeeded but returned no URL");
  return { url, id: pr.id, alreadyExisted: false };
}
