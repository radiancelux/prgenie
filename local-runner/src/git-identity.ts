import type { GhResult } from "./github.js";

export type GitIdentityCheck = {
  ok: boolean;
  missing: Array<"name" | "email">;
  name: string | null;
  email: string | null;
};

export async function readGitConfigValue(
  repoPath: string,
  key: "user.name" | "user.email",
  git: (cwd: string, args: string[]) => Promise<GhResult>,
): Promise<string | null> {
  const res = await git(repoPath, ["config", "--local", key]);
  const v = res.stdout.trim();
  return v ? v : null;
}

export async function checkGitIdentity(
  repoPath: string,
  git: (cwd: string, args: string[]) => Promise<GhResult>,
): Promise<GitIdentityCheck> {
  const name = await readGitConfigValue(repoPath, "user.name", git);
  const email = await readGitConfigValue(repoPath, "user.email", git);
  const missing: GitIdentityCheck["missing"] = [];
  if (!name) missing.push("name");
  if (!email) missing.push("email");
  return { ok: missing.length === 0, missing, name, email };
}

/** Exact local-repo git config commands (works on Windows; no shell). */
export function formatGitIdentityFixCommands(repoPath: string): string {
  const quoted = JSON.stringify(repoPath);
  return `git -C ${quoted} config user.name "Your Name" && git -C ${quoted} config user.email "you@example.com"`;
}

export function formatGitIdentityPreflightMessage(repoPath: string, missing: GitIdentityCheck["missing"]): string {
  const fields = missing.map((m) => `user.${m}`).join(" and ");
  return `Git author identity is not set in the target repo (missing ${fields}). Run: ${formatGitIdentityFixCommands(repoPath)}`;
}
