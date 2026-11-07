import path from "node:path";

export function repoSlugFromPath(repoPath: string): string {
  const base = path.basename(repoPath.replace(/[/\\]+$/, ""));
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "repo";
}

export function cursorWorktreeDir(repoSlug: string, jobId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".cursor", "worktrees", repoSlug, jobId);
}

export function jobsDir(dataDir: string): string {
  return path.join(dataDir, "jobs");
}

export function logsDir(dataDir: string): string {
  return path.join(dataDir, "logs");
}

export function jobFile(dataDir: string, jobId: string): string {
  return path.join(jobsDir(dataDir), `${jobId}.json`);
}

export function jobLogFile(dataDir: string, jobId: string): string {
  return path.join(logsDir(dataDir), `${jobId}.log`);
}

/** Job ids become file names; anything beyond `[A-Za-z0-9_-]` could escape the data dir. */
export function isSafeJobId(jobId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(jobId);
}

export function archivedDir(dataDir: string): string {
  return path.join(dataDir, "archived");
}

export function archivedJobsDir(dataDir: string): string {
  return path.join(archivedDir(dataDir), "jobs");
}

export function archivedLogsDir(dataDir: string): string {
  return path.join(archivedDir(dataDir), "logs");
}

export function archivedJobFile(dataDir: string, jobId: string): string {
  return path.join(archivedJobsDir(dataDir), `${jobId}.json`);
}

export function archivedLogFile(dataDir: string, jobId: string): string {
  return path.join(archivedLogsDir(dataDir), `${jobId}.log`);
}

export function notifySettingsFile(dataDir: string): string {
  return path.join(dataDir, "notify-settings.json");
}

export function runnerSettingsFile(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}
