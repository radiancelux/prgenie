import { spawn } from "node:child_process";

export type GhResult = { code: number; stdout: string; stderr: string };

export async function gh(cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function git(cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
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
  body: string;
  created_at: string;
}

/** Accept only a verdict comment posted at or after `sinceIso` (current review round). */
export function findVerdictInCommentsSince(
  comments: IssueComment[],
  sinceIso: string,
): Verdict | null {
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return null;

  const inRound = comments
    .filter((c) => Date.parse(c.created_at) >= sinceMs)
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
      return asArray.filter(
        (c): c is IssueComment =>
          c != null &&
          typeof c === "object" &&
          typeof (c as IssueComment).body === "string" &&
          typeof (c as IssueComment).created_at === "string",
      );
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

export async function fetchPrCommentVerdictSince(
  cwd: string,
  prNumber: number,
  sinceIso: string,
): Promise<Verdict | null> {
  const res = await gh(cwd, [
    "api",
    `repos/{owner}/{repo}/issues/${prNumber}/comments`,
    "--paginate",
  ]);
  if (res.code !== 0) return null;
  const comments = parseIssueCommentsPayload(res.stdout);
  return findVerdictInCommentsSince(comments, sinceIso);
}

export type GitFn = typeof git;

export async function isBranchSyncedWithOrigin(
  cwd: string,
  branch: string,
  gitImpl: GitFn = git,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchRes = await gitImpl(cwd, ["fetch", "origin", branch]);
  if (fetchRes.code !== 0) {
    const reason = fetchRes.stderr.trim() || fetchRes.stdout.trim() || "git fetch failed";
    return { ok: false, reason };
  }
  const local = await gitImpl(cwd, ["rev-parse", "HEAD"]);
  const remote = await gitImpl(cwd, ["rev-parse", `refs/remotes/origin/${branch}`]);
  if (local.code !== 0 || remote.code !== 0) {
    return { ok: false, reason: "could not resolve local or remote HEAD" };
  }
  if (local.stdout.trim() !== remote.stdout.trim()) {
    return { ok: false, reason: "local HEAD does not match origin" };
  }
  return { ok: true };
}
