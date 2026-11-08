import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { JobInput, JobRecord, StartJobArgs } from "./types.js";
import { shouldHideMergedJob } from "./ci.js";
import { resolveJobTarget, normalizeJobType, type ResolvedJobTarget } from "./job-target.js";
import { ValidationError } from "./validation-error.js";
import { isDocsTemplateId } from "./docs-prompts.js";
import { resolveJobTicket } from "./linear-ticket.js";
import {
  archivedJobFile,
  archivedJobsDir,
  archivedLogFile,
  archivedLogsDir,
  isSafeJobId,
  jobFile,
  jobLogFile,
  jobsDir,
  logsDir,
  repoSlugFromPath,
} from "./paths.js";
import { resolveJobTitle } from "./job-display.js";
import { repoOwnerNameFromGitOrigin, repoOwnerNameFromRemoteUrl } from "./repo-display.js";
import { loadSettings, resolveDefaultDriverId, resolveDefaultMaxRounds } from "./settings.js";
import type { RunnerConfig } from "./config.js";
import { mergeJobErrors } from "./job-error.js";
import { resolveStageModelsForJob } from "./job-models.js";
import type { CiStatusInfo } from "./types.js";
import { withStoreLock } from "./store-lock.js";

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function ciCheckedAtMs(ci: CiStatusInfo | null | undefined): number {
  if (!ci?.checkedAt) return 0;
  const t = Date.parse(ci.checkedAt);
  return Number.isNaN(t) ? 0 : t;
}

function mergeCiStatus(
  onDisk: CiStatusInfo | null,
  incoming: CiStatusInfo | null,
): CiStatusInfo | null {
  if (!incoming) return onDisk;
  if (!onDisk) return incoming;
  return ciCheckedAtMs(incoming) >= ciCheckedAtMs(onDisk) ? incoming : onDisk;
}

export async function saveJob(dataDir: string, job: JobRecord): Promise<void> {
  return withStoreLock(dataDir, async () => {
    const loadedAt = job.updatedAt;
    job.updatedAt = new Date().toISOString();
    // Stale in-memory copies (CI poll, worktree cleanup) must not resurrect an archived job.
    if (await fileExists(archivedJobFile(dataDir, job.id))) return;
    const livePath = jobFile(dataDir, job.id);
    const onDisk = await readJobFile(livePath);
    if (!onDisk) {
      if (await fileExists(archivedJobFile(dataDir, job.id))) return;
    } else {
      job.ciStatus = mergeCiStatus(onDisk.ciStatus, job.ciStatus);
      if (onDisk.worker && !job.worker) {
        job.worker = onDisk.worker;
      }
      // Only a copy older than disk merges errors; an up-to-date writer may clear `error`.
      if (onDisk.updatedAt > (loadedAt ?? "")) {
        job.error = mergeJobErrors(onDisk.error, job.error);
      }
    }
    await atomicWriteJson(livePath, job);
  });
}

/**
 * Side writers (CI poll, worktree cleanup) hold copies that may predate the job loop's latest
 * save; re-read and apply only the fields they own so `stage` and loop state never roll back.
 */
export async function patchJob(
  dataDir: string,
  id: string,
  mutate: (job: JobRecord) => void,
): Promise<JobRecord | null> {
  const fresh = await loadJob(dataDir, id);
  if (!fresh) return null;
  mutate(fresh);
  await saveJob(dataDir, fresh);
  return fresh;
}

export async function loadJob(dataDir: string, id: string): Promise<JobRecord | null> {
  if (!isSafeJobId(id)) return null;
  return readJobFile(jobFile(dataDir, id));
}

/** Archived job with `archivedAt` and `logPath` pointing at `archived/`. */
export async function loadArchivedJob(dataDir: string, id: string): Promise<JobRecord | null> {
  if (!isSafeJobId(id)) return null;
  const job = await readJobFile(archivedJobFile(dataDir, id));
  if (!job) return null;
  job.archivedAt = job.archivedAt || job.updatedAt;
  job.logPath = archivedLogFile(dataDir, id);
  return job;
}

async function readJobFile(filePath: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const job = JSON.parse(raw) as JobRecord;
    if (job.archivedAt === undefined) job.archivedAt = null;
    if (job.driverId === undefined) job.driverId = "cursor-agent";
    if (job.prIsDraft === undefined) job.prIsDraft = null;
    if (job.approveHeadSha === undefined) job.approveHeadSha = null;
    if (job.readyPromotedAt === undefined) job.readyPromotedAt = null;
    if (job.title === undefined || job.title === null) {
      job.title = job.input?.branch?.trim() || job.id.slice(0, 8);
    }
    if (!job.stageModels && job.model) {
      job.stageModels = { build: job.model, review: job.model, fix: job.model };
    }
    return job;
  } catch {
    return null;
  }
}

async function listJsonIds(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""))
      .filter(isSafeJobId);
  } catch {
    return [];
  }
}

export async function listJobIds(dataDir: string): Promise<string[]> {
  return listJsonIds(jobsDir(dataDir));
}

export async function listArchivedJobIds(dataDir: string): Promise<string[]> {
  return listJsonIds(archivedJobsDir(dataDir));
}

function sortNewestFirst(jobs: JobRecord[]): JobRecord[] {
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listArchivedJobs(dataDir: string): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (const id of await listArchivedJobIds(dataDir)) {
    const j = await loadArchivedJob(dataDir, id);
    if (j) jobs.push(j);
  }
  return sortNewestFirst(jobs);
}

export type ListJobsOptions = { includeArchived?: boolean };

/** Live jobs under `jobs/`; archived jobs (`archived/jobs/`) only when `includeArchived`. */
export async function listJobs(dataDir: string, opts: ListJobsOptions = {}): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (const id of await listJobIds(dataDir)) {
    const j = await loadJob(dataDir, id);
    if (j) jobs.push(j);
  }
  if (opts.includeArchived) jobs.push(...(await listArchivedJobs(dataDir)));
  return sortNewestFirst(jobs);
}

export type ListJobsForDisplayOptions = { includeFinished?: boolean; includeArchived?: boolean };

/** Jobs shown on the dashboard and via list_jobs (merged PRs drop off after ~1h). */
export async function listJobsForDisplay(
  dataDir: string,
  nowMs = Date.now(),
  opts: ListJobsForDisplayOptions = {},
): Promise<JobRecord[]> {
  const jobs = await listJobs(dataDir);
  const live = opts.includeFinished ? jobs : jobs.filter((j) => !shouldHideMergedJob(j, nowMs));
  if (!opts.includeArchived) return live;
  return sortNewestFirst([...live, ...(await listArchivedJobs(dataDir))]);
}

export async function jobsDashboardMeta(
  dataDir: string,
  nowMs = Date.now(),
): Promise<{ totalOnDisk: number; mergedHidden: number; archived: number }> {
  const jobs = await listJobs(dataDir);
  const mergedHidden = jobs.filter((j) => shouldHideMergedJob(j, nowMs)).length;
  const archived = (await listArchivedJobIds(dataDir)).length;
  return { totalOnDisk: jobs.length, mergedHidden, archived };
}

/** Move `jobs/<id>.json` and `logs/<id>.log` under `archived/`. Caller checks the stage. */
export async function moveJobToArchive(dataDir: string, job: JobRecord): Promise<JobRecord> {
  return withStoreLock(dataDir, async () => moveJobToArchiveUnlocked(dataDir, job));
}

async function moveJobToArchiveUnlocked(dataDir: string, job: JobRecord): Promise<JobRecord> {
  const dest = archivedJobFile(dataDir, job.id);
  if (await fileExists(dest)) {
    const existing = await readJobFile(dest);
    if (existing) return existing;
    throw new Error(`job is already archived: ${job.id}`);
  }
  await mkdir(archivedJobsDir(dataDir), { recursive: true });
  await mkdir(archivedLogsDir(dataDir), { recursive: true });
  await rename(jobFile(dataDir, job.id), dest);
  await renameIfExists(jobLogFile(dataDir, job.id), archivedLogFile(dataDir, job.id));
  job.archivedAt = new Date().toISOString();
  job.logPath = archivedLogFile(dataDir, job.id);
  await atomicWriteJson(dest, job);
  return job;
}

export type RestoreJobFilesResult =
  { ok: true; job: JobRecord } | { ok: false; code: "not_found" | "collision"; error: string };

/** Move an archived job back under `jobs/` and `logs/`; never overwrites a live job. */
export async function restoreJobFromArchive(
  dataDir: string,
  id: string,
): Promise<RestoreJobFilesResult> {
  return withStoreLock(dataDir, async () => restoreJobFromArchiveUnlocked(dataDir, id));
}

async function restoreJobFromArchiveUnlocked(
  dataDir: string,
  id: string,
): Promise<RestoreJobFilesResult> {
  const job = await loadArchivedJob(dataDir, id);
  if (!job) return { ok: false, code: "not_found", error: "archived job not found" };
  if ((await fileExists(jobFile(dataDir, id))) || (await fileExists(jobLogFile(dataDir, id)))) {
    return { ok: false, code: "collision", error: "a live job with this id already exists" };
  }
  await ensureDataDirs(dataDir);
  await rename(archivedJobFile(dataDir, id), jobFile(dataDir, id));
  await renameIfExists(archivedLogFile(dataDir, id), jobLogFile(dataDir, id));
  job.archivedAt = null;
  job.logPath = jobLogFile(dataDir, id);
  await saveJob(dataDir, job);
  return { ok: true, job };
}

/** Canonical `owner/name` for a job target; the queue matches same-branch jobs on this key. */
export async function resolveJobRepoSlug(
  target: Pick<Extract<ResolvedJobTarget, { ok: true }>, "repoPath" | "remote" | "repoSlug">,
): Promise<string> {
  const slug = target.repoSlug;
  if (target.remote?.trim()) {
    return repoOwnerNameFromRemoteUrl(target.remote) ?? repoSlugFromPath(target.remote) ?? slug;
  }
  if (target.repoPath?.trim()) {
    const fromOrigin = await repoOwnerNameFromGitOrigin(target.repoPath);
    return fromOrigin ?? (slug.includes("/") ? slug : repoSlugFromPath(target.repoPath));
  }
  return slug;
}

export async function createJob(
  dataDir: string,
  args: StartJobArgs,
  defaults: {
    model: string;
    dryRun: boolean;
    driverId?: string;
    config: RunnerConfig;
  },
): Promise<JobRecord> {
  await ensureDataDirs(dataDir);
  const settings = await loadSettings(dataDir);
  const jobType = normalizeJobType(args);
  const target = resolveJobTarget(args, settings, defaults.config);
  if (!target.ok) {
    throw new ValidationError(target.error);
  }
  const id = randomUUID();
  const docsTemplate =
    args.docsTemplate && isDocsTemplateId(args.docsTemplate) ? args.docsTemplate : undefined;
  const promptFile = args.promptFile?.trim() || (jobType === "docs" ? "" : "");
  if (jobType === "code" && !promptFile) {
    throw new ValidationError("promptFile is required for code jobs");
  }
  if (jobType === "docs" && !promptFile && !docsTemplate) {
    throw new ValidationError("docs jobs need docsTemplate or promptFile");
  }
  const slug = await resolveJobRepoSlug(target);
  const ticketUrls = [
    ...new Set(
      [args.ticketUrl?.trim(), ...(args.ticketUrls ?? [])].filter((u): u is string => !!u),
    ),
  ];
  const ticket = resolveJobTicket({
    branch: args.branch,
    ticketUrl: ticketUrls[0],
    linearIssue: args.linearIssue,
  });
  const title =
    (await resolveJobTitle({
      title: args.title,
      ticketUrl: ticket.ticketUrl ?? args.ticketUrl,
      linearIssue: ticket.linearIssue,
      branch: args.branch,
      promptFile: promptFile || args.promptFile || "",
    })) ||
    args.branch.trim() ||
    id.slice(0, 8);
  const driverId =
    args.driver?.trim() || defaults.driverId?.trim() || resolveDefaultDriverId(settings);
  const stageResolved = resolveStageModelsForJob(
    defaults.config,
    settings,
    {
      repoPath: target.repoPath,
      branch: args.branch,
      promptFile: promptFile || "",
      model: args.model,
      stageModels: args.stageModels,
      driver: driverId,
    } as JobInput,
    driverId,
  );

  const input: JobInput = {
    repoPath: target.repoPath,
    branch: args.branch,
    promptFile: promptFile || "",
    reviewPromptFile: args.reviewPromptFile,
    fixPromptFile: args.fixPromptFile,
    maxRounds: args.maxRounds,
    model: args.model,
    stageModels: args.stageModels,
    driver: driverId,
    remote: target.remote ?? args.remote,
    ticketUrl: args.ticketUrl,
    ticketUrls: args.ticketUrls,
    linearIssue: args.linearIssue,
    jobType,
    profile: jobType,
    docsTemplate,
    title,
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
    maxRounds: args.maxRounds ?? resolveDefaultMaxRounds(settings),
    model: stageResolved.build,
    stageModels: {
      build: stageResolved.build,
      review: stageResolved.review,
      fix: stageResolved.fix,
    },
    effectiveSnapshot: {
      maxRounds: args.maxRounds ?? resolveDefaultMaxRounds(settings),
      stageModels: {
        build: stageResolved.build,
        review: stageResolved.review,
        fix: stageResolved.fix,
      },
      baseRef: settings.defaultBaseBranch,
      watchdogInactivityMs: settings.watchdog.inactivityMs,
      watchdogStageCapMs: settings.watchdog.stageCapMs,
      watchdogRecoveryAttempts: settings.watchdog.recoveryAttempts,
    },
    watchdog: {
      lastActivityAt: null,
      stageStartedAt: null,
      recoveryAttemptsUsed: 0,
      lastRecoveryAt: null,
      lastStallReason: null,
    },
    driverId,
    worktreePath: null,
    repoSlug: slug,
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: ticket.linearIssue,
    ticketUrl: ticket.ticketUrl,
    ...(ticketUrls.length > 1 ? { ticketUrls } : {}),
    title,
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
