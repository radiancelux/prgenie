import type { PrInfo } from "./github.js";
import type { GhFn } from "./github-rate-limit.js";
import { ghWithGithubRetry, isGithubRateLimitResult } from "./github-rate-limit.js";
import type { GhResult } from "./spawn-cmd.js";
import { repoSlugFromPrUrl } from "./ci.js";

export type RestGh = GhFn;

function repoApiPrefix(repoSlug: string | null | undefined): string {
  const slug = repoSlug?.trim();
  if (slug && slug.includes("/")) return `repos/${slug}`;
  return "repos/{owner}/{repo}";
}

export function headRefForBranch(repoSlug: string | null | undefined, branch: string): string {
  const owner = repoSlug?.split("/")[0]?.trim();
  if (owner) return `${owner}:${branch}`;
  return branch;
}

async function resolveHeadQualifier(
  cwd: string,
  branch: string,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<string> {
  const slug = resolveRepoSlug(repoSlug, null);
  if (slug?.includes("/")) return headRefForBranch(slug, branch);
  const res = await ghWithGithubRetry(
    cwd,
    ["api", "repos/{owner}/{repo}", "--jq", ".owner.login"],
    gh,
  );
  const owner = res.stdout.trim();
  if (owner) return `${owner}:${branch}`;
  return branch;
}

type RestPull = {
  number?: number;
  html_url?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: { sha?: string };
};

function parsePullInfo(row: RestPull): PrInfo | null {
  if (typeof row.number === "number" && row.html_url) {
    return { number: row.number, url: row.html_url };
  }
  return null;
}

export async function restFindOpenPrForBranch(
  cwd: string,
  branch: string,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<PrInfo | null> {
  const prefix = repoApiPrefix(resolveRepoSlug(repoSlug, null));
  const head = await resolveHeadQualifier(cwd, branch, repoSlug, gh);
  const res = await ghWithGithubRetry(
    cwd,
    ["api", `${prefix}/pulls`, "-f", `head=${head}`, "-f", "state=open", "-f", "per_page=5"],
    gh,
  );
  if (res.code !== 0 || !res.stdout.trim()) return null;
  try {
    const rows = JSON.parse(res.stdout) as RestPull[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return parsePullInfo(rows[0]);
  } catch {
    return null;
  }
}

export async function restGetPull(
  cwd: string,
  prNumber: number,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<RestPull | null> {
  const prefix = repoApiPrefix(resolveRepoSlug(repoSlug, null));
  const res = await ghWithGithubRetry(cwd, ["api", `${prefix}/pulls/${prNumber}`], gh);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout) as RestPull;
  } catch {
    return null;
  }
}

export async function restCreateDraftPull(
  cwd: string,
  branch: string,
  title: string,
  base: string,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<{ ok: true; pr: PrInfo } | { ok: false; error: string; transient?: boolean }> {
  const prefix = repoApiPrefix(resolveRepoSlug(repoSlug, null));
  const res = await ghWithGithubRetry(
    cwd,
    [
      "api",
      "-X",
      "POST",
      `${prefix}/pulls`,
      "-f",
      `title=${title}`,
      "-f",
      `head=${branch}`,
      "-f",
      `base=${base}`,
      "-f",
      "draft=true",
      "-f",
      `body=${title}`,
    ],
    gh,
  );
  if (res.code === 0 && res.stdout.trim()) {
    try {
      const row = JSON.parse(res.stdout) as RestPull;
      const pr = parsePullInfo(row);
      if (pr) return { ok: true, pr };
    } catch {
      // fall through
    }
  }
  const err = (res.stderr || res.stdout).trim() || "REST pull create failed";
  if (isGithubRateLimitResult(res)) {
    return { ok: false, error: err.slice(0, 400), transient: true };
  }
  if (/already exists|A pull request already exists/i.test(err)) {
    const existing = await restFindOpenPrForBranch(cwd, branch, repoSlug, gh);
    if (existing) return { ok: true, pr: existing };
  }
  return { ok: false, error: err.slice(0, 400) };
}

export async function restMarkPullReady(
  cwd: string,
  prNumber: number,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const prefix = repoApiPrefix(resolveRepoSlug(repoSlug, null));
  const res = await ghWithGithubRetry(
    cwd,
    ["api", "-X", "PATCH", `${prefix}/pulls/${prNumber}`, "-f", "draft=false"],
    gh,
  );
  if (res.code === 0) return { ok: true };
  const err = (res.stderr || res.stdout).trim() || "REST pull ready failed";
  if (/already/i.test(err)) return { ok: true };
  return { ok: false, error: err.slice(0, 400) };
}

export async function restPostIssueComment(
  cwd: string,
  prNumber: number,
  body: string,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<boolean> {
  const prefix = repoApiPrefix(resolveRepoSlug(repoSlug, null));
  const res = await ghWithGithubRetry(
    cwd,
    ["api", "-X", "POST", `${prefix}/issues/${prNumber}/comments`, "-f", `body=${body}`],
    gh,
  );
  return res.code === 0;
}

export type CheckRunRow = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string;
  html_url?: string;
};

export async function restFetchCheckRunsForRef(
  cwd: string,
  sha: string,
  repoSlug: string | null | undefined,
  gh: RestGh,
): Promise<CheckRunRow[]> {
  const prefix = repoApiPrefix(resolveRepoSlug(repoSlug, null));
  const res = await ghWithGithubRetry(
    cwd,
    ["api", `${prefix}/commits/${sha}/check-runs`, "-f", "per_page=100"],
    gh,
  );
  if (res.code !== 0 || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout) as { check_runs?: CheckRunRow[] };
    return Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
  } catch {
    return [];
  }
}

export function resolveRepoSlug(
  explicit: string | null | undefined,
  prUrl: string | null | undefined,
): string | null {
  return explicit?.trim() || repoSlugFromPrUrl(prUrl) || null;
}

export function ghRestOrGraphql(
  cwd: string,
  args: string[],
  gh: GhFn,
  wrapped: (cwd: string, args: string[], gh: GhFn) => Promise<GhResult> = ghWithGithubRetry,
): Promise<GhResult> {
  return wrapped(cwd, args, gh);
}
