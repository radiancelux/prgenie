import { git } from "./github.js";

/** Parse `owner/name` from https or ssh git remote URLs. */
export function repoOwnerNameFromRemoteUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const gh = u.match(/github\.com[/:]([^/]+\/[^/?.#]+)/i);
  if (gh) return gh[1].replace(/\.git$/i, "");
  const generic = u.match(/[:/@]([^/]+\/[^/?.#]+?)(?:\.git)?\/?(?:#.*)?$/);
  return generic ? generic[1].replace(/\.git$/i, "") : null;
}

/** True only for remotes hosted on github.com (https, scp-style ssh, or ssh:// URLs). */
export function isGitHubRemoteUrl(url: string): boolean {
  return /(?:^|[@/])github\.com[/:][^/\s]+\/[^/\s?#]+/i.test(url.trim());
}

export function repoOwnerNameFromPrUrl(prUrl: string | null | undefined): string | null {
  if (!prUrl?.trim()) return null;
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//i);
  return m ? m[1] : null;
}

export function repoBasenameFromPath(repoPath: string | null | undefined): string {
  if (!repoPath?.trim()) return "—";
  const normalized = repoPath.replace(/[/\\]+$/, "");
  const i = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const base = i >= 0 ? normalized.slice(i + 1) : normalized;
  return base || "—";
}

export type JobRepoDisplayFields = {
  repoSlug?: string | null;
  prUrl?: string | null;
  input?: { repoPath?: string; remote?: string } | null;
};

/** Dashboard label: owner/name when known, else repo folder basename. */
export function jobRepoDisplayLabel(job: JobRepoDisplayFields): string {
  const slug = job.repoSlug?.trim();
  if (slug && slug.includes("/")) return slug;
  const fromRemote = job.input?.remote ? repoOwnerNameFromRemoteUrl(job.input.remote) : null;
  if (fromRemote) return fromRemote;
  const fromPr = repoOwnerNameFromPrUrl(job.prUrl);
  if (fromPr) return fromPr;
  const pathName = job.input?.repoPath?.trim();
  if (pathName) return repoBasenameFromPath(pathName);
  return slug || "—";
}

export async function repoOwnerNameFromGitOrigin(repoPath: string): Promise<string | null> {
  const root = repoPath.trim();
  if (!root) return null;
  const res = await git(root, ["remote", "get-url", "origin"]);
  if (res.code !== 0) return null;
  return repoOwnerNameFromRemoteUrl(res.stdout.trim());
}
