import { readFile } from "node:fs/promises";
import type { RunnerConfig } from "./config.js";
import { isJobArchived } from "./job-cwd.js";
import { driverSupportsAuto } from "./job-models.js";
import {
  decideJobStart,
  jobsHoldingBranch,
  listJobsForQueue,
  type QueueOptions,
} from "./job-queue.js";
import { loadSettings } from "./settings.js";
import { loadArchivedJob, loadJob, saveJob } from "./store.js";
import type { JobContinueHistoryEntry, JobRecord } from "./types.js";
import { ensureContinueWorktree } from "./worktree.js";
import { assertContinueMaxRounds, normalizeContinueJobArgs } from "./settings-validation.js";
import type { ContinueJobArgs } from "./types.js";

export const CONTINUE_TERMINAL_STAGES = new Set([
  "approved",
  "changes_remaining",
  "stuck",
  "stopped",
  "failed",
  "interrupted",
]);

export type ContinueJobErrorCode =
  | "invalid_id"
  | "not_found"
  | "archived"
  | "running"
  | "not_terminal"
  | "branch_conflict"
  | "no_pr";

export class ContinueJobError extends Error {
  constructor(
    message: string,
    readonly code: ContinueJobErrorCode,
    readonly stage?: string,
  ) {
    super(message);
    this.name = "ContinueJobError";
  }
}

export type ContinueJobResult = {
  job: JobRecord;
  worktree: "reused" | "recreated" | "none";
  queued: boolean;
};

export type ContinueJobDeps = {
  isRunning: (id: string) => boolean;
  ensureWorktree?: typeof ensureContinueWorktree;
  readPromptFile?: (filePath: string) => Promise<string>;
};

async function readOptionalPromptFile(
  filePath: string | undefined,
  readFn: (p: string) => Promise<string>,
): Promise<string> {
  const path = filePath?.trim();
  if (!path) return "";
  try {
    return (await readFn(path)).trim();
  } catch {
    throw new ContinueJobError(`promptFile not readable: ${path}`, "not_found");
  }
}

function mergeContinuePrompt(prompt?: string, fromFile?: string): string | undefined {
  const parts = [prompt?.trim(), fromFile?.trim()].filter(Boolean) as string[];
  if (!parts.length) return undefined;
  return parts.join("\n\n");
}

export async function prepareJobContinue(
  config: RunnerConfig,
  args: ContinueJobArgs,
  deps: ContinueJobDeps,
): Promise<ContinueJobResult> {
  const id = args.id.trim();
  if (!id) throw new ContinueJobError("id is required", "invalid_id");

  let job = await loadJob(config.dataDir, id);
  if (!job) {
    const archived = await loadArchivedJob(config.dataDir, id);
    if (archived) {
      throw new ContinueJobError(
        `job is archived; restore it before continuing: ${id}`,
        "archived",
      );
    }
    throw new ContinueJobError(`job not found: ${id}`, "not_found");
  }
  if (isJobArchived(job)) {
    throw new ContinueJobError(`job is archived; restore it before continuing: ${id}`, "archived");
  }
  if (deps.isRunning(id)) {
    throw new ContinueJobError(`job is still running (${job.stage})`, "running", job.stage);
  }
  if (!CONTINUE_TERMINAL_STAGES.has(job.stage)) {
    throw new ContinueJobError(
      `job is not in a terminal stage (${job.stage}); stop it first`,
      "not_terminal",
      job.stage,
    );
  }
  if (!job.prUrl?.trim()) {
    throw new ContinueJobError(
      "job has no PR; continue requires an existing pull request",
      "no_pr",
    );
  }

  const settings = await loadSettings(config.dataDir);
  const queueOpts: QueueOptions = { isRunning: deps.isRunning };
  const jobs = await listJobsForQueue(config.dataDir);
  const holders = jobsHoldingBranch(jobs, job.input.branch, job.repoSlug, queueOpts).filter(
    (j) => j.id !== id,
  );
  if (holders.length > 0) {
    throw new ContinueJobError(
      `another active job is already using branch ${job.input.branch}`,
      "branch_conflict",
    );
  }

  const readFn = deps.readPromptFile ?? ((p: string) => readFile(p, "utf8"));
  const fromFile = await readOptionalPromptFile(args.promptFile, readFn);
  const instructions = mergeContinuePrompt(args.prompt, fromFile);

  const extraRounds = args.extraRounds ?? 1;
  assertContinueMaxRounds(job.maxRounds, extraRounds);
  const nextMax = job.maxRounds + extraRounds;

  let worktree: ContinueJobResult["worktree"] = "none";
  if (!job.dryRun && job.input.repoPath?.trim()) {
    const ensure = deps.ensureWorktree ?? ensureContinueWorktree;
    const wt = await ensure(
      job.input.repoPath,
      job.id,
      job.input.branch,
      job.worktreePath,
      settings,
    );
    job.worktreePath = wt.path;
    worktree = wt.reused ? "reused" : "recreated";
  } else if (job.input.repoPath?.trim()) {
    job.worktreePath = job.input.repoPath;
    worktree = "reused";
  }

  const history: JobContinueHistoryEntry = {
    at: new Date().toISOString(),
    extraRounds,
    priorMaxRounds: job.maxRounds,
    newMaxRounds: nextMax,
    prompt: instructions ?? null,
    model: args.model ?? null,
  };
  if (!job.continueHistory) job.continueHistory = [];
  job.continueHistory.push(history);

  job.maxRounds = nextMax;
  if (job.effectiveSnapshot) job.effectiveSnapshot.maxRounds = nextMax;

  if (args.model?.trim()) {
    const m = args.model.trim();
    if (m === "auto" && !driverSupportsAuto(job.driverId)) {
      throw new ContinueJobError(
        `model "auto" is not supported for driver ${job.driverId}`,
        "not_terminal",
      );
    }
    if (job.stageModels) job.stageModels.fix = m;
  }

  if (instructions) {
    job.steerQueue.push(instructions);
  }

  job.stopRequested = false;
  job.stage = "fixing";
  if (job.queueState?.queued) job.queueState = undefined;

  const decision = decideJobStart(
    jobs.filter((j) => j.id !== id),
    job.input.branch,
    job.repoSlug,
    settings.maxActiveJobs,
    queueOpts,
  );
  let queued = false;
  if (decision.action === "queue") {
    job.queueState = {
      queued: true,
      position: decision.position,
      since: new Date().toISOString(),
    };
    queued = true;
  } else if (decision.action === "reject") {
    throw new ContinueJobError(decision.reason, "branch_conflict");
  }

  await saveJob(config.dataDir, job);
  return { job, worktree, queued };
}

export async function continueJobFromRaw(
  config: RunnerConfig,
  raw: Record<string, unknown>,
  deps: ContinueJobDeps,
): Promise<ContinueJobResult> {
  const args = normalizeContinueJobArgs(raw);
  return prepareJobContinue(config, args, deps);
}
