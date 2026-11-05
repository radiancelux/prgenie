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
  const view = await gh(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    "url,number",
  ]);
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

export async function fetchLatestPrCommentVerdict(
  cwd: string,
  prNumber: number,
): Promise<Verdict | null> {
  const res = await gh(cwd, [
    "api",
    `repos/{owner}/{repo}/issues/${prNumber}/comments`,
    "--paginate",
    "-q",
    ".[] | .body",
  ]);
  if (res.code !== 0) return null;
  return parseVerdictFromText(res.stdout);
}
