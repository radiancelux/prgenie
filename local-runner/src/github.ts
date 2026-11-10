import { spawnCommand, type GhResult } from "./spawn-cmd.js";

export type { GhResult };

export async function gh(cwd: string, args: string[]): Promise<GhResult> {
  return spawnCommand("gh", cwd, args);
}

export async function git(cwd: string, args: string[]): Promise<GhResult> {
  return spawnCommand("git", cwd, args);
}

export type FetchPrMergedResult = { merged: boolean; mergedAt: string | null };

export type FetchPrMergedFn = (
  cwd: string,
  target: { prNumber?: number | null; branch?: string },
) => Promise<FetchPrMergedResult>;

export async function fetchPrMerged(
  cwd: string,
  target: { prNumber?: number | null; branch?: string },
): Promise<FetchPrMergedResult> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) return { merged: false, mergedAt: null };

  const ghRes = await gh(cwd, ["pr", "view", ref, "--json", "state,mergedAt"]);
  if (ghRes.code !== 0) return { merged: false, mergedAt: null };
  try {
    const parsed = JSON.parse(ghRes.stdout) as { state?: string; mergedAt?: string | null };
    const merged = parsed.state === "MERGED" || (parsed.mergedAt != null && parsed.mergedAt !== "");
    return { merged, mergedAt: merged ? (parsed.mergedAt ?? null) : null };
  } catch {
    return { merged: false, mergedAt: null };
  }
}

export interface PrInfo {
  url: string;
  number: number;
}

export async function findPrForBranch(cwd: string, branch: string): Promise<PrInfo | null> {
  const view = await gh(cwd, ["pr", "view", branch, "--json", "url,number"]);
  if (view.code !== 0) return null;
  try {
    const parsed = JSON.parse(view.stdout) as { url?: string; number?: number };
    if (parsed.url && typeof parsed.number === "number") {
      return { url: parsed.url, number: parsed.number };
    }
  } catch {
    // ignore
  }
  return null;
}

export type Verdict = "APPROVE" | "CHANGES";

const VERDICT_RE = /VERDICT:\s*(APPROVE|CHANGES)\s*$/im;

export function parseVerdictFromText(text: string): Verdict | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(VERDICT_RE);
    if (m) return m[1] as Verdict;
  }
  const m = text.match(VERDICT_RE);
  return m ? (m[1] as Verdict) : null;
}

export interface IssueComment {
  id?: number;
  body: string;
  created_at: string;
}

/** When falling back to timestamps, accept comments slightly before local round start. */
export const VERDICT_ROUND_TIME_SKEW_MS = 30_000;

export type VerdictRoundScope = {
  sinceIso: string;
  /** Last issue comment id on the PR before this review round started. */
  afterCommentId?: number;
  /** Last pull request review id before this review round started. */
  afterReviewId?: number;
  skewMs?: number;
};

function commentInReviewRound(c: IssueComment, scope: VerdictRoundScope): boolean {
  if (scope.afterCommentId != null && typeof c.id === "number") {
    return c.id > scope.afterCommentId;
  }
  const sinceMs = Date.parse(scope.sinceIso);
  if (Number.isNaN(sinceMs)) return false;
  const skewMs = scope.skewMs ?? VERDICT_ROUND_TIME_SKEW_MS;
  return Date.parse(c.created_at) >= sinceMs - skewMs;
}

/** Accept only a verdict comment from the current review round. */
export function findVerdictInCommentsSince(
  comments: IssueComment[],
  scope: VerdictRoundScope,
): Verdict | null {
  const inRound = comments
    .filter((c) => commentInReviewRound(c, scope))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  for (const c of inRound) {
    const verdict = parseVerdictFromText(c.body);
    if (verdict) return verdict;
  }
  return null;
}

function parseIssueCommentsPayload(stdout: string): IssueComment[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const asArray = JSON.parse(trimmed) as unknown;
    if (Array.isArray(asArray)) {
      return asArray.filter((c): c is IssueComment => {
        if (c == null || typeof c !== "object") return false;
        const row = c as IssueComment;
        if (typeof row.body !== "string" || typeof row.created_at !== "string") return false;
        return true;
      });
    }
  } catch {
    // fall through — paginate may emit one JSON object per line
  }
  const comments: IssueComment[] = [];
  for (const line of trimmed.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as IssueComment;
      if (typeof row.body === "string" && typeof row.created_at === "string") {
        comments.push(row);
      }
    } catch {
      // ignore bad lines
    }
  }
  return comments;
}

export async function fetchPrIssueComments(cwd: string, prNumber: number): Promise<IssueComment[]> {
  const res = await gh(cwd, [
    "api",
    `repos/{owner}/{repo}/issues/${prNumber}/comments`,
    "--paginate",
  ]);
  if (res.code !== 0) return [];
  return parseIssueCommentsPayload(res.stdout);
}

export async function fetchLatestPrCommentId(cwd: string, prNumber: number): Promise<number> {
  const comments = await fetchPrIssueComments(cwd, prNumber);
  let maxId = 0;
  for (const c of comments) {
    if (typeof c.id === "number" && c.id > maxId) maxId = c.id;
  }
  return maxId;
}

export async function fetchPrCommentVerdictSince(
  cwd: string,
  prNumber: number,
  scope: VerdictRoundScope,
): Promise<Verdict | null> {
  const comments = await fetchPrIssueComments(cwd, prNumber);
  return findVerdictInCommentsSince(comments, scope);
}

export interface PullRequestReview {
  id?: number;
  body: string;
  submitted_at: string;
}

function reviewInReviewRound(r: PullRequestReview, scope: VerdictRoundScope): boolean {
  if (scope.afterReviewId != null && typeof r.id === "number") {
    return r.id > scope.afterReviewId;
  }
  const sinceMs = Date.parse(scope.sinceIso);
  if (Number.isNaN(sinceMs)) return false;
  const skewMs = scope.skewMs ?? VERDICT_ROUND_TIME_SKEW_MS;
  return Date.parse(r.submitted_at) >= sinceMs - skewMs;
}

/** Accept only a verdict from a PR review body in the current review round. */
export function findVerdictInReviewsSince(
  reviews: PullRequestReview[],
  scope: VerdictRoundScope,
): Verdict | null {
  const inRound = reviews
    .filter((r) => reviewInReviewRound(r, scope))
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));

  for (const r of inRound) {
    const verdict = parseVerdictFromText(r.body);
    if (verdict) return verdict;
  }
  return null;
}

function parsePullRequestReviewsPayload(stdout: string): PullRequestReview[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const asArray = JSON.parse(trimmed) as unknown;
    if (Array.isArray(asArray)) {
      return asArray.filter((r): r is PullRequestReview => {
        if (r == null || typeof r !== "object") return false;
        const row = r as PullRequestReview;
        if (typeof row.body !== "string" || typeof row.submitted_at !== "string") return false;
        return true;
      });
    }
  } catch {
    // fall through
  }
  const reviews: PullRequestReview[] = [];
  for (const line of trimmed.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as PullRequestReview;
      if (typeof row.body === "string" && typeof row.submitted_at === "string") {
        reviews.push(row);
      }
    } catch {
      // ignore bad lines
    }
  }
  return reviews;
}

export async function fetchPrReviews(cwd: string, prNumber: number): Promise<PullRequestReview[]> {
  const res = await gh(cwd, [
    "api",
    `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
    "--paginate",
  ]);
  if (res.code !== 0) return [];
  return parsePullRequestReviewsPayload(res.stdout);
}

export async function fetchLatestPrReviewId(cwd: string, prNumber: number): Promise<number> {
  const reviews = await fetchPrReviews(cwd, prNumber);
  let maxId = 0;
  for (const r of reviews) {
    if (typeof r.id === "number" && r.id > maxId) maxId = r.id;
  }
  return maxId;
}

/** Prefer issue-comment verdicts; fall back to PR review bodies in the same round. */
export async function fetchPrVerdictSince(
  cwd: string,
  prNumber: number,
  scope: VerdictRoundScope,
): Promise<Verdict | null> {
  const fromComments = await fetchPrCommentVerdictSince(cwd, prNumber, scope);
  if (fromComments) return fromComments;
  const reviews = await fetchPrReviews(cwd, prNumber);
  return findVerdictInReviewsSince(reviews, scope);
}

export async function postPrComment(cwd: string, prNumber: number, body: string): Promise<boolean> {
  const res = await gh(cwd, ["pr", "comment", String(prNumber), "--body", body]);
  return res.code === 0;
}

export type GitFn = typeof git;

async function worktreeCwdExists(cwd: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(cwd);
    return true;
  } catch {
    return false;
  }
}

function spawnGitEnoentReason(cwd: string, stderr: string): string | null {
  if (!/ENOENT/i.test(stderr)) return null;
  return `job worktree directory is missing (${cwd}). When the checkout path does not exist, Node reports spawn git ENOENT — that means a missing working directory, not a missing git binary. Use continue_job to recreate the worktree.`;
}

export async function isBranchSyncedWithOrigin(
  cwd: string,
  branch: string,
  gitImpl: GitFn = git,
): Promise<
  { ok: true } | { ok: false; reason: string; mismatch?: "ahead" | "behind" | "diverged" }
> {
  if (!(await worktreeCwdExists(cwd))) {
    return {
      ok: false,
      reason: `job worktree directory is missing (${cwd}). When the checkout path does not exist, Node reports spawn git ENOENT — that means a missing working directory, not a missing git binary. Use continue_job to recreate the worktree.`,
    };
  }
  const fetchRes = await gitImpl(cwd, ["fetch", "origin", branch]);
  if (fetchRes.code !== 0) {
    const combined = `${fetchRes.stderr}\n${fetchRes.stdout}`.trim();
    const enoent = spawnGitEnoentReason(cwd, combined);
    if (enoent) return { ok: false, reason: enoent };
    const reason = combined || "git fetch failed";
    return { ok: false, reason };
  }
  const local = await gitImpl(cwd, ["rev-parse", "HEAD"]);
  const remote = await gitImpl(cwd, ["rev-parse", `refs/remotes/origin/${branch}`]);
  if (local.code !== 0 || remote.code !== 0) {
    const combined = `${local.stderr}\n${remote.stderr}`.trim();
    const enoent = spawnGitEnoentReason(cwd, combined);
    if (enoent) return { ok: false, reason: enoent };
    return { ok: false, reason: "could not resolve local or remote HEAD" };
  }
  const localSha = local.stdout.trim();
  const remoteSha = remote.stdout.trim();
  if (localSha === remoteSha) return { ok: true };

  const remoteIsAncestor = await gitImpl(cwd, ["merge-base", "--is-ancestor", remoteSha, localSha]);
  if (remoteIsAncestor.code === 0) {
    return {
      ok: false,
      reason: "local branch has unpushed commits (ahead of origin)",
      mismatch: "ahead",
    };
  }
  const localIsAncestor = await gitImpl(cwd, ["merge-base", "--is-ancestor", localSha, remoteSha]);
  if (localIsAncestor.code === 0) {
    return { ok: false, reason: "local HEAD is behind origin", mismatch: "behind" };
  }
  return {
    ok: false,
    reason:
      "local HEAD diverged from origin (for example after a rebase). A normal git push cannot update the remote without force-push, which the runner does not perform.",
    mismatch: "diverged",
  };
}
