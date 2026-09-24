import { exportPushArgs, ensureExportUpstream } from "./base-ref.js";
import { git } from "./git.js";
import {
  describeRepoGithubBind,
  ensureRepoGithub,
  githubPrCreateArgs,
  runGh,
  withGhBodyFile,
} from "./github-ops.js";
import { getLocalPr, isArchivedPr, listLocalPrs, setLocalPrStatus } from "./prs.js";
import { localBaseRef, releaseArchivedLoop } from "./worktrees.js";
import { haltWatch, resumeWatch } from "./watch.js";
import { throwIfAborted, type RunProgressOptions } from "./progress.js";

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
    let state: GithubPrHeadState;
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
  return `${pr.headSha}:refs/heads/${localBaseRef(pr.headRef)}`;
}

/** Structured report when GitHub PR opened but local release/prune did not finish (RAD-95). */
export type ExportPartialFailure = {
  kind: "partial_failure";
  message: string;
  prOpened: true;
  url: string;
  worktreePath: string | null;
  checkedOutBase: boolean;
  prunedWorktree: boolean;
  reopen: boolean;
  pruneError: string | null;
};

export function formatExportPartialFailure(partial: ExportPartialFailure): string {
  return partial.message;
}

/**
 * Build the export partial-failure payload from a release result.
 * Shared by `exportLocalPr` so the contract is unit-testable without push/gh.
 */
export function exportPartialFailureFromRelease(
  url: string,
  released: {
    checkedOutBase: boolean;
    prunedWorktree: boolean;
    primaryPath: string | null;
    reopen: boolean;
    worktreeLeftoverPath: string | null;
    pruneError: string | null;
  },
  archivedWorktreePath: string | null,
): ExportPartialFailure | null {
  if (released.prunedWorktree) return null;
  const worktreePath =
    released.worktreeLeftoverPath ?? archivedWorktreePath ?? released.primaryPath;
  const reason = released.reopen
    ? `reopen primary at ${released.primaryPath ?? "unknown"} then prune`
    : (released.pruneError ?? "prune failed");
  return {
    kind: "partial_failure",
    message: `PR opened; worktree still at ${worktreePath ?? "unknown"}; ${reason}`,
    prOpened: true,
    url,
    worktreePath: worktreePath ?? null,
    checkedOutBase: released.checkedOutBase,
    prunedWorktree: released.prunedWorktree,
    reopen: released.reopen,
    pruneError: released.pruneError,
  };
}

export async function exportLocalPr(
  cwd: string,
  id: string,
  options: { skipValidation?: boolean } & RunProgressOptions = {},
): Promise<{
  url: string;
  id: string;
  alreadyExisted: boolean;
  checkedOutBase: boolean;
  prunedWorktree: boolean;
  primaryPath: string | null;
  reopen: boolean;
  worktreeLeftoverPath: string | null;
  pruneError: string | null;
  partialFailure: ExportPartialFailure | null;
}> {
  const { validateExport } = await import("./export-validation.js");
  const onProgress = options.onProgress;
  const signal = options.signal;

  // RAD-95: fail unbound before expensive shepherd CI — not only after validation.
  // File bind only (same as requireGithubBindForReviewed) so we do not hang on gh CLI.
  throwIfAborted(signal);
  const earlyBind = await describeRepoGithubBind(cwd);
  if (!earlyBind.bound) {
    throw new Error(
      earlyBind.prompt ??
        "This repo is not bound to a GitHub login. Ask which account, then prgenie gh use <login>.",
    );
  }

  const validation = await validateExport(cwd, id, options);
  if (!validation.ok) {
    const envNote =
      validation.ciEnvUnhealthy && !options.skipValidation
        ? ` CI env unhealthy (first-class): ${validation.ciEnvUnhealthy.message}`
        : "";
    throw new Error(
      `Export blocked. ${validation.issues.join(" ")}${envNote}${
        options.skipValidation ? "" : " Use --skip-validation to override (not recommended)."
      }`,
    );
  }

  throwIfAborted(signal);
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
    // RAD-94: push recorded SHA, then set upstream to origin/<headRef> (never the base).
    const pushArgv = exportPushArgs(pr);
    const pushCmd = `git ${pushArgv.join(" ")}`;
    onProgress?.({ phase: "push", state: "start", command: pushCmd });
    const pushStarted = Date.now();
    const push = await git(cwd, pushArgv, {
      allowFail: true,
      signal,
    });
    if (push.code !== 0) {
      onProgress?.({
        phase: "push",
        state: "fail",
        command: pushCmd,
        elapsedMs: Date.now() - pushStarted,
        message: push.stderr.trim() || `git push failed for ${pr.headRef}`,
      });
      throw new Error(push.stderr.trim() || `git push failed for ${pr.headRef}`);
    }
    await ensureExportUpstream(cwd, pr.headRef);
    onProgress?.({
      phase: "push",
      state: "pass",
      command: pushCmd,
      elapsedMs: Date.now() - pushStarted,
    });

    throwIfAborted(signal);
    const createCmd = "gh pr create";
    onProgress?.({ phase: "create_pr", state: "start", command: createCmd });
    const createStarted = Date.now();
    const existing = await runGh(githubPrViewArgs(pr.headRef, { json: "url", jq: ".url" }), {
      cwd,
      signal,
    });
    let url: string;
    let alreadyExisted = false;
    if (existing.code === 0 && existing.stdout.trim().startsWith("http")) {
      url = existing.stdout.trim();
      alreadyExisted = true;
    } else {
      // Body via --body-file: cmd.exe truncates multiline --body even inside quotes (RAD-129).
      // Audit: other runGh sites only pass view/json tokens — no multiline argv payloads.
      const bodyText = pr.body.trim() || pr.title;
      const created = await withGhBodyFile(bodyText, (bodyFile) =>
        runGh(
          githubPrCreateArgs({
            title: pr.title,
            bodyFile,
            base: ghBase(pr.baseRef),
            head: pr.headRef,
          }),
          { cwd, signal },
        ),
      );
      if (created.code !== 0) {
        onProgress?.({
          phase: "create_pr",
          state: "fail",
          command: createCmd,
          elapsedMs: Date.now() - createStarted,
          message: created.stderr.trim() || created.stdout.trim() || "gh pr create failed",
        });
        throw new Error(created.stderr.trim() || created.stdout.trim() || "gh pr create failed");
      }
      url =
        created.stdout
          .trim()
          .split("\n")
          .find((line) => /^https?:\/\//.test(line)) ?? created.stdout.trim();
      if (!url) throw new Error("gh pr create succeeded but returned no URL");
    }
    onProgress?.({
      phase: "create_pr",
      state: "pass",
      command: createCmd,
      elapsedMs: Date.now() - createStarted,
    });

    if (pr.status !== "approved") {
      await setLocalPrStatus(cwd, pr.id, "approved");
    }
    const archived = await getLocalPr(cwd, pr.id);
    const released = await releaseArchivedLoop(cwd, archived);

    const partialFailure = exportPartialFailureFromRelease(url, released, archived.worktreePath);

    return {
      url,
      id: pr.id,
      alreadyExisted,
      checkedOutBase: released.checkedOutBase,
      prunedWorktree: released.prunedWorktree,
      primaryPath: released.primaryPath,
      reopen: released.reopen,
      worktreeLeftoverPath: released.worktreeLeftoverPath,
      pruneError: released.pruneError,
      partialFailure,
    };
  } catch (err) {
    await resumeWatch(cwd);
    throw err;
  }
}
