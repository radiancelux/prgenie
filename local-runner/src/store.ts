import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { JobInput, JobRecord, StartJobArgs } from "./types.js";
import { shouldHideMergedJob } from "./ci.js";
import { resolveJobTicket } from "./linear-ticket.js";
import { jobFile, jobLogFile, jobsDir, logsDir, repoSlugFromPath } from "./paths.js";
import { repoOwnerNameFromGitOrigin, repoOwnerNameFromRemoteUrl } from "./repo-display.js";
import { loadSettings, resolveDefaultDriverId } from "./settings.js";

export async function ensureDataDirs(dataDir: string): Promise<void> {
  await mkdir(jobsDir(dataDir), { recursive: true });
  await mkdir(logsDir(dataDir), { recursive: true });
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export async function saveJob(dataDir: string, job: JobRecord): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await atomicWriteJson(jobFile(dataDir, job.id), job);
}

export async function loadJob(dataDir: string, id: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(jobFile(dataDir, id), "utf8");
    const job = JSON.parse(raw) as JobRecord;
    if (job.archivedAt === undefined) job.archivedAt = null;
    if (job.driverId === undefined) job.driverId = "cursor-agent";
    if (job.prIsDraft === undefined) job.prIsDraft = null;
    if (job.approveHeadSha === undefined) job.approveHeadSha = null;
    if (job.readyPromotedAt === undefined) job.readyPromotedAt = null;
    return job;
  } catch {
    return null;
  }
}

export async function listJobIds(dataDir: string): Promise<string[]> {
  try {
    const names = await readdir(jobsDir(dataDir));
    return names.filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

export type ListJobsOptions = { includeArchived?: boolean };

export async function listJobs(dataDir: string, _opts: ListJobsOptions = {}): Promise<JobRecord[]> {
  const ids = await listJobIds(dataDir);
  const jobs: JobRecord[] = [];
  for (const id of ids) {
    const j = await loadJob(dataDir, id);
    if (j) jobs.push(j);
  }
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs;
}

/** Jobs shown on the dashboard and via list_jobs (merged PRs drop off after ~1h). */
export async function listJobsForDisplay(
  dataDir: string,
  nowMs = Date.now(),
): Promise<JobRecord[]> {
  const jobs = await listJobs(dataDir);
  return jobs.filter((j) => !shouldHideMergedJob(j, nowMs));
}

export async function createJob(
  dataDir: string,
  args: StartJobArgs,
  defaults: { model: string; dryRun: boolean; driverId?: string },
): Promise<JobRecord> {
  await ensureDataDirs(dataDir);
  const settings = await loadSettings(dataDir);
  const id = randomUUID();
  const repoPath = args.repoPath?.trim() || "";
  let slug = "remote";
  if (args.remote?.trim()) {
    slug = repoOwnerNameFromRemoteUrl(args.remote) ?? repoSlugFromPath(args.remote);
  } else if (repoPath) {
    const fromOrigin = await repoOwnerNameFromGitOrigin(repoPath);
    slug = fromOrigin ?? repoSlugFromPath(repoPath);
  }
  const ticket = resolveJobTicket({
    branch: args.branch,
    ticketUrl: args.ticketUrl,
    linearIssue: args.linearIssue,
  });
  const input: JobInput = {
    repoPath: repoPath || "",
    branch: args.branch,
    promptFile: args.promptFile,
    reviewPromptFile: args.reviewPromptFile,
    fixPromptFile: args.fixPromptFile,
    maxRounds: args.maxRounds,
    model: args.model,
    driver: args.driver,
    remote: args.remote,
    ticketUrl: args.ticketUrl,
    linearIssue: args.linearIssue,
  };
  const logPath = jobLogFile(dataDir, id);
  await writeFile(logPath, "", "utf8");
  const job: JobRecord = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input,
    stage: "building",
    reviewRound: 0,
    maxRounds: args.maxRounds ?? 2,
    model: args.model?.trim() || settings.defaultModel?.trim() || defaults.model,
    driverId: args.driver?.trim() || defaults.driverId?.trim() || resolveDefaultDriverId(settings),
    worktreePath: null,
    repoSlug: slug,
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: ticket.linearIssue,
    ticketUrl: ticket.ticketUrl,
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath,
    steerQueue: [],
    stopRequested: false,
    dryRun: args.dryRun ?? defaults.dryRun,
    archivedAt: null,
  };
  await saveJob(dataDir, job);
  return job;
}

export async function readLogTail(logPath: string, maxBytes = 32_768): Promise<string> {
  try {
    const buf = await readFile(logPath);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}
