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

export function notifySettingsFile(dataDir: string): string {
  return path.join(dataDir, "notify-settings.json");
}

export function runnerSettingsFile(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}
