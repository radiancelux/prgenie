import { appendFile } from "node:fs/promises";
import type { RunnerConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import {
  fetchLatestPrCommentId,
  fetchLatestPrReviewId,
  fetchPrVerdictSince,
  findPrForBranch,
  isBranchSyncedWithOrigin,
  postPrComment,
  type Verdict,
} from "./github.js";
import { resolveReviewVerdict } from "./review-verdict.js";
import { JobControl } from "./job-control.js";
import {
  DEFAULT_FIX_PROMPT,
  DEFAULT_IMPLEMENT_PROMPT,
  DEFAULT_REVIEW_PROMPT,
  DRY_RUN_PLACEHOLDER_PROMPT,
} from "./prompts.js";
import {
  isDocsTemplateId,
  DOCS_REVIEW_PROMPT,
  resolveDocsFixPrompt,
  resolveDocsImplementPrompt,
} from "./docs-prompts.js";
import { isDocsJob } from "./doc-checks.js";
import { formatJobEmailHtml, sendResendEmail, type FetchFn } from "./resend.js";
import {
  findDriverEntry,
  loadNotifySettings,
  loadSettings,
  resolveNotifyRecipient,
} from "./notify-settings.js";
import { loadJob, readLogTail, saveJob } from "./store.js";
import type { JobEvent, JobRecord, JobStage } from "./types.js";
import { sumTokenUsageFromLog } from "./usage.js";
import {
  branchHasNoCommitsBeyondBase,
  cloneRepo,
  ensureWorktree,
  mergeOntoBase,
} from "./worktree.js";
import { branchExistsOnOrigin, worktreePathExists } from "./worktree-cleanup.js";
import { cursorWorktreeDir } from "./paths.js";
import { fetchPrViewInfo, readHeadSha } from "./draft-pr.js";
import { runAgentWithWatchdog, type StageWatchdogOptions } from "./stage-watchdog.js";
import { adoptRaisedWatchdog } from "./watchdog-extend.js";
import { isComputeJob } from "./job-type-watchdog.js";
import { createProcessActivitySampler } from "./watchdog-process-activity.js";
import { trackShellToolLine, type ShellToolTracker } from "./stream-json-log.js";
import { modelForActiveStage, recordActualModel, stageModelKeyForRun } from "./job-models.js";
import { setJobError } from "./job-error.js";
import { parseWatchdogPolicy } from "./runner-policy.js";
import {
  jobExpectsPr,
  NO_PR_GUARD_MESSAGE,
  resolvePostBuildNoPr,
  resolvePostBuildNoPrError,
  isTransientPrEnsureError,
} from "./job-pr-policy.js";
import { diagnosePrSetupIssues, enrichNoPrGuardMessage } from "./job-preflight.js";
import { ensureDraftPrAfterBuild } from "./post-build-pr.js";
import { git as defaultGit, gh as defaultGh } from "./github.js";
import { maybeCleanupJobWorktree } from "./worktree-cleanup.js";
import { readStagePromptFile, type PromptFileBases } from "./prompt-file.js";
import { hasProveEvidence, proveEvidenceGateApplies } from "./prove-it-works.js";

export type JobCallbacks = {
  onEvent?: (jobId: string, event: JobEvent) => void;
  onPrLinked?: (jobId: string) => void;
  fetchImpl?: FetchFn;
  agentRunner?: AgentRunner;
  watchdogTiming?: WatchdogTiming;
};

type WatchdogTiming = Pick<StageWatchdogOptions, "now" | "tickMs" | "childGraceMs">;

function promptBases(job: JobRecord, worktreePath: string): PromptFileBases {
  return { worktreePath, repoPath: job.input.repoPath };
}

/** Relative prompt paths resolve against the worktree, then repoPath, when the stage runs. */
async function readPromptFile(
  label: string,
  filePath: string,
  fallback: string,
  bases: PromptFileBases,
  job: JobRecord,
  callbacks?: JobCallbacks,
): Promise<string> {
  try {
    const text = await readStagePromptFile(filePath, bases, label);
    return text ?? fallback;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runnerLog(callbacks, job, `[runner] ${message}`);
    throw err instanceof Error ? err : new Error(message);
  }
}

const NOTIFY_DEDUP_MAX = 500;
/** Last notified event per job, oldest evicted first (Map keeps insertion order). */
const notifyDedup = new Map<string, string>();

function rememberNotified(jobId: string, eventKey: string): void {
  notifyDedup.delete(jobId);
  notifyDedup.set(jobId, eventKey);
  while (notifyDedup.size > NOTIFY_DEDUP_MAX) {
    const oldest = notifyDedup.keys().next().value;
    if (oldest === undefined) break;
    notifyDedup.delete(oldest);
  }
}

async function notify(
  config: RunnerConfig,
  job: JobRecord,
  headline: string,
  fetchImpl?: FetchFn,
  eventKey?: string,
): Promise<void> {
  const settings = await loadNotifySettings(config.dataDir);
  const full = await loadSettings(config.dataDir);
  const to = resolveNotifyRecipient(config, settings);
  if (!to || !config.resendApiKey) return;
  if (eventKey) {
    const prev = notifyDedup.get(job.id);
    if (prev === eventKey) return;
    rememberNotified(job.id, eventKey);
  }
  const failureLike = /failed|stuck|watchdog/i.test(headline);
  if (failureLike) {
    if (/stuck/i.test(headline) && !full.notifyEvents.onStuck) return;
    if (/failed/i.test(headline) && !full.notifyEvents.onFailed) return;
    if (/watchdog/i.test(headline) && !full.notifyEvents.onWatchdogExhausted) return;
  }
  const html = formatJobEmailHtml({
    headline,
    prUrl: job.prUrl,
    verdict: job.lastVerdict,
    stage: job.stage,
    jobId: job.id,
  });
  const result = await sendResendEmail(
    config.resendApiKey,
    { to, subject: headline, html },
    fetchImpl,
  );
  if (!result.ok) {
    job.error = setJobError(job.error, `email: ${result.error}`);
  }
}

async function refreshExtendedWatchdog(config: RunnerConfig, job: JobRecord): Promise<void> {
  try {
    adoptRaisedWatchdog(job, await loadJob(config.dataDir, job.id));
  } catch {
    // A torn or missing read keeps the cap already in memory.
  }
}

function watchdogPolicyForJob(job: JobRecord, settings: Awaited<ReturnType<typeof loadSettings>>) {
  const snap = job.effectiveSnapshot;
  if (snap) {
    return parseWatchdogPolicy({
      inactivityMs: snap.watchdogInactivityMs,
      stageCapMs: snap.watchdogStageCapMs,
      recoveryAttempts: snap.watchdogRecoveryAttempts,
    });
  }
  return settings.watchdog;
}

/** In-flight jobs keep the base ref recorded at creation, not the live Setup value. */
function baseRefSettingsForJob(
  job: JobRecord,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Awaited<ReturnType<typeof loadSettings>> {
  const snap = job.effectiveSnapshot;
  if (!snap) return settings;
  return { ...settings, defaultBaseBranch: snap.baseRef };
}

async function runAgentStage(
  runner: AgentRunner,
  config: RunnerConfig,
  job: JobRecord,
  control: JobControl,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  stage: "building" | "reviewing" | "fixing",
  opts: Parameters<AgentRunner["run"]>[0],
  timing?: WatchdogTiming,
): Promise<{ code: number; output: string } | null> {
  const policy = () => watchdogPolicyForJob(job, settings);
  job.watchdog = job.watchdog ?? {
    lastActivityAt: null,
    stageStartedAt: null,
    recoveryAttemptsUsed: 0,
    lastRecoveryAt: null,
    lastStallReason: null,
  };
  job.watchdog.stageStartedAt = new Date().toISOString();
  job.watchdog.lastActivityAt = job.watchdog.stageStartedAt;
  job.runtime = { waitMode: "agent" };
  const shellTracker: ShellToolTracker = { open: null };
  const procSampler = isComputeJob(job)
    ? createProcessActivitySampler({ now: timing?.now ?? Date.now })
    : null;
  let lastRuntimePersist = 0;
  const syncRuntime = (sample?: { cpuPercent?: number; busiestComm?: string }) => {
    const open = shellTracker.open;
    if (open) {
      const procLabel =
        sample?.busiestComm && sample.cpuPercent != null
          ? `${sample.busiestComm} (${sample.cpuPercent}% CPU)`
          : sample?.busiestComm;
      job.runtime = {
        waitMode: "command",
        command: {
          summary: open.summary,
          detail: open.detail,
          startedAt: new Date(open.startedAtMs).toISOString(),
          processLabel: procLabel,
        },
      };
    } else {
      job.runtime = { waitMode: "agent" };
    }
  };
  const model = modelForActiveStage(job, stage);
  recordActualModel(job, stageModelKeyForRun(stage, job.reviewRound), model);
  // The serve-side supervisor budgets detached workers per stage from the on-disk clock.
  await persistJob(config, job, control);

  const clock = timing?.now ?? Date.now;
  const wd = await runAgentWithWatchdog(
    {
      ...timing,
      policy,
      refreshPolicy: () => refreshExtendedWatchdog(config, job),
      killChild: () => runner.kill(),
      pollActivity: procSampler
        ? () => {
            const sample = procSampler.sample(runner.agentRootPid());
            if (sample.active) syncRuntime(sample);
            return sample.active;
          }
        : undefined,
      onActivity: () => {
        job.watchdog!.lastActivityAt = new Date().toISOString();
        const t = clock();
        if (t - lastRuntimePersist >= 2_000) {
          lastRuntimePersist = t;
          void persistJob(config, job, control).catch(() => undefined);
        }
      },
      onStall: (reason) => {
        job.watchdog!.lastStallReason = reason;
      },
      onRecovery: () => {
        job.watchdog!.recoveryAttemptsUsed += 1;
        job.watchdog!.lastRecoveryAt = new Date().toISOString();
      },
    },
    async (tap) => {
      const onLine = (line: string) => {
        tap(line);
        const wasOpen = shellTracker.open;
        trackShellToolLine(shellTracker, line, clock());
        syncRuntime();
        job.watchdog!.lastActivityAt = new Date().toISOString();
        if (shellTracker.open !== wasOpen) {
          lastRuntimePersist = clock();
          void persistJob(config, job, control).catch(() => undefined);
        }
      };
      runner.on("line", onLine);
      try {
        return await runner.run({ ...opts, model });
      } finally {
        runner.off("line", onLine);
        job.runtime = null;
      }
    },
  );

  if (!wd.ok) {
    job.error = setJobError(job.error, `watchdog: ${wd.reason}`);
    return null;
  }
  return wd.value;
}

function emit(cb: JobCallbacks | undefined, job: JobRecord, event: JobEvent): void {
  cb?.onEvent?.(job.id, event);
}

async function runnerLog(cb: JobCallbacks | undefined, job: JobRecord, line: string) {
  await appendFile(job.logPath, `${line}\n`, "utf8").catch(() => undefined);
  emit(cb, job, { type: "log", line });
}

const PROVE_EVIDENCE_FAIL =
  "Stage finished without PROVE: EVIDENCE (run the real artifact/tests and include command + output in the agent message).";

/** Default building-stage implementor prompt (docs template or code). Architect + prove sections live in defaults (#247). */
function buildingImplementFallback(job: JobRecord): string {
  if (isDocsJob(job)) {
    const template = isDocsTemplateId(job.input.docsTemplate) ? job.input.docsTemplate : null;
    return resolveDocsImplementPrompt(template);
  }
  return DEFAULT_IMPLEMENT_PROMPT;
}

/** Default implement/fix prompts require real verification output; custom prompt files opt out. */
async function acceptProveEvidenceOrFail(
  config: RunnerConfig,
  job: JobRecord,
  control: JobControl,
  stage: "building" | "fixing",
  output: string,
  outputFormat: "stream-json" | "text",
  promptFile: string | undefined | null,
  callbacks: JobCallbacks | undefined,
  onReject?: () => void,
): Promise<boolean> {
  if (!proveEvidenceGateApplies(promptFile)) return true;
  // Code dry runs without a prompt file use a placeholder implementor pass (#195).
  if (stage === "building" && job.dryRun && !job.input.promptFile?.trim() && !isDocsJob(job))
    return true;
  if (hasProveEvidence(output, outputFormat)) return true;
  await runnerLog(
    callbacks,
    job,
    `[runner] ${stage} agent exited 0 but produced no PROVE: EVIDENCE block with command output.`,
  );
  job.error = PROVE_EVIDENCE_FAIL;
  onReject?.();
  await setStage(config, job, "failed", control, callbacks);
  return false;
}

function isTransientPersistError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /EPERM|EBUSY|EACCES|Failed to rename temp JSON/i.test(msg);
}

async function persistJob(
  config: RunnerConfig,
  job: JobRecord,
  control: JobControl,
): Promise<void> {
  JobControl.syncSteerQueueForPersist(job, control);
  const usage = await sumTokenUsageFromLog(job.logPath);
  if (usage) job.tokenUsage = usage;
  try {
    await saveJob(config.dataDir, job);
  } catch (err) {
    if (!isTransientPersistError(err)) throw err;
    await appendFile(
      job.logPath,
      `[runner] job state write retry failed: ${err instanceof Error ? err.message : String(err)}\n`,
      "utf8",
    ).catch(() => undefined);
  }
}

const STAGES_CLEAR_ERROR = new Set<JobStage>(["building", "reviewing", "fixing", "approved"]);

async function setStage(
  config: RunnerConfig,
  job: JobRecord,
  stage: JobStage,
  control: JobControl,
  cb?: JobCallbacks,
): Promise<void> {
  job.stage = stage;
  if (STAGES_CLEAR_ERROR.has(stage)) job.error = null;
  if (stage !== "building") job.statusDetail = null;
  await persistJob(config, job, control);
  emit(cb, job, { type: "stage", stage, reviewRound: job.reviewRound });
}

async function runFixStage(
  runner: AgentRunner,
  config: RunnerConfig,
  job: JobRecord,
  control: JobControl,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  baseSettings: Awaited<ReturnType<typeof loadSettings>>,
  wt: string,
  outputFormat: "stream-json" | "text",
  driverEntry: NonNullable<ReturnType<typeof findDriverEntry>>,
  callbacks?: JobCallbacks,
): Promise<boolean> {
  await setStage(config, job, "fixing", control, callbacks);
  if (!job.dryRun) {
    await mergeOntoBase(wt, baseSettings);
  }
  const fixDefault = isDocsJob(job) ? resolveDocsFixPrompt() : DEFAULT_FIX_PROMPT;
  const fixPrompt = await readPromptFile(
    "fixPromptFile",
    job.input.fixPromptFile ?? "",
    fixDefault,
    promptBases(job, wt),
    job,
    callbacks,
  );
  const fixSteer = control.drainSteer();
  const prLabel = job.dryRun ? "(dry run — simulated PR)" : String(job.prUrl);
  const fixFull = fixSteer
    ? `${fixPrompt}\n\nPR: ${prLabel}\n\n--- steer ---\n${fixSteer}`
    : `${fixPrompt}\n\nPR: ${prLabel}`;

  const fixRun = await runAgentStage(
    runner,
    config,
    job,
    control,
    settings,
    "fixing",
    {
      cwd: wt,
      prompt: fixFull,
      model: job.model,
      logPath: job.logPath,
      dryRun: job.dryRun,
      outputFormat,
      signal: control.signal,
      driverId: job.driverId,
      driverEntry,
    },
    callbacks?.watchdogTiming,
  );
  if (control.stopRequested) {
    runner.kill();
    job.stopRequested = true;
    await setStage(config, job, "stopped", control, callbacks);
    return false;
  }
  if (!fixRun || fixRun.code !== 0) {
    if (!fixRun) {
      await setStage(config, job, "stuck", control, callbacks);
      await notify(
        config,
        job,
        `Watchdog exhausted (fix): ${job.input.branch}`,
        callbacks?.fetchImpl,
        "watchdog-fix",
      );
    } else {
      job.error = `fixer exited ${fixRun.code}`;
      await setStage(config, job, "failed", control, callbacks);
    }
    return false;
  }
  if (
    !(await acceptProveEvidenceOrFail(
      config,
      job,
      control,
      "fixing",
      fixRun.output,
      outputFormat,
      job.input.fixPromptFile,
      callbacks,
    ))
  ) {
    return false;
  }
  if (!(await ensurePushedBeforeReview(config, job, wt, control, callbacks))) return false;
  if (!job.dryRun) {
    await notify(config, job, `PR pushed after fix round ${job.reviewRound}`, callbacks?.fetchImpl);
  }
  return true;
}

async function ensurePushedBeforeReview(
  config: RunnerConfig,
  job: JobRecord,
  wt: string,
  control: JobControl,
  callbacks?: JobCallbacks,
): Promise<boolean> {
  if (job.dryRun) return true;
  if (!(await worktreePathExists(wt))) {
    const repoRoot = job.input.repoPath?.trim();
    const onOrigin = repoRoot != null && (await branchExistsOnOrigin(repoRoot, job.input.branch));
    job.error = onOrigin
      ? `Job worktree is missing (${wt}) but origin already has branch ${job.input.branch}. Use continue_job to recreate the checkout.`
      : `Job worktree is missing (${wt}). Use continue_job to recreate the checkout.`;
    await setStage(config, job, "stuck", control, callbacks);
    return false;
  }
  const sync = await isBranchSyncedWithOrigin(wt, job.input.branch);
  if (sync.ok) return true;
  const prefix = /missing|diverged|force-push/i.test(sync.reason)
    ? sync.reason
    : `Branch not pushed to origin before review: ${sync.reason}`;
  job.error = prefix;
  await setStage(config, job, "stuck", control, callbacks);
  return false;
}

export async function runJobLoop(
  config: RunnerConfig,
  job: JobRecord,
  control: JobControl,
  callbacks?: JobCallbacks,
): Promise<void> {
  const runner = callbacks?.agentRunner ?? new AgentRunner();
  control.registerKill(() => runner.kill());
  runner.on("line", (line: string) => {
    emit(callbacks, job, { type: "log", line });
  });

  const checkStop = async (): Promise<boolean> => {
    if (control.stopRequested) {
      runner.kill();
      job.stopRequested = true;
      await setStage(config, job, "stopped", control, callbacks);
      return true;
    }
    return false;
  };

  try {
    if (job.preflightWarnings?.length) {
      for (const line of job.preflightWarnings) {
        emit(callbacks, job, { type: "log", line: `[preflight] ${line}` });
      }
    }
    const settings = await loadSettings(config.dataDir);
    const baseSettings = baseRefSettingsForJob(job, settings);
    const driverEntry =
      findDriverEntry(settings, job.driverId) ?? findDriverEntry(settings, "cursor-agent");
    if (!driverEntry) {
      job.error = `Unknown driver: ${job.driverId}`;
      await setStage(config, job, "failed", control, callbacks);
      return;
    }
    const outputFormat: "stream-json" | "text" =
      driverEntry.kind === "local-model" ? "text" : "stream-json";

    let repoRoot = job.input.repoPath;
    if (job.input.remote && !repoRoot) {
      const dest = cursorWorktreeDir(job.repoSlug, `${job.id}-src`);
      await cloneRepo(job.input.remote, dest);
      repoRoot = dest;
      job.input.repoPath = dest;
    }
    if (!repoRoot) {
      job.error = "repoPath or remote required";
      await setStage(config, job, "failed", control, callbacks);
      return;
    }

    let wt = repoRoot;
    if (job.dryRun) {
      job.worktreePath = repoRoot;
      await persistJob(config, job, control);
    } else {
      job.runtime = {
        waitMode: "command",
        command: {
          summary: "git worktree add",
          detail: job.input.branch,
          startedAt: new Date().toISOString(),
        },
      };
      await persistJob(config, job, control);
      const wtResult = await ensureWorktree(repoRoot, job.id, job.input.branch, baseSettings, {
        dataDir: config.dataDir,
      });
      wt = wtResult.path;
      job.worktreePath = wt;
      job.baseRef = wtResult.baseRef;
      job.baseSha = wtResult.baseSha;
      if (job.effectiveSnapshot) job.effectiveSnapshot.baseRef = wtResult.baseRef;
      job.runtime = null;
      await persistJob(config, job, control);
    }

    if (!job.dryRun && !job.prUrl) {
      const existingPr = await findPrForBranch(wt, job.input.branch, job.repoSlug);
      if (existingPr) {
        job.prUrl = existingPr.url;
        job.prNumber = existingPr.number;
        await persistJob(config, job, control);
        emit(callbacks, job, { type: "pr", url: existingPr.url });
        callbacks?.onPrLinked?.(job.id);
      }
    }

    // --- building / implementor (runs for new prompts even when an open PR was adopted) ---
    if (job.stage === "building") {
      const skipImplementor = Boolean(job.postBuildPendingPr);
      if (!skipImplementor) {
        let prompt: string;
        const bases = promptBases(job, wt);
        if (job.dryRun && !job.input.promptFile?.trim() && !isDocsJob(job)) {
          prompt = DRY_RUN_PLACEHOLDER_PROMPT;
        } else {
          prompt = await readPromptFile(
            "promptFile",
            job.input.promptFile,
            buildingImplementFallback(job),
            bases,
            job,
            callbacks,
          );
        }
        const steer = control.drainSteer();
        const fullPrompt = steer ? `${prompt}\n\n--- steer ---\n${steer}` : prompt;
        const baseRun = {
          cwd: wt,
          prompt: fullPrompt,
          model: job.model,
          logPath: job.logPath,
          dryRun: job.dryRun,
          outputFormat,
          signal: control.signal,
          driverId: job.driverId,
          driverEntry,
        };
        const result = await runAgentStage(
          runner,
          config,
          job,
          control,
          settings,
          "building",
          baseRun,
          callbacks?.watchdogTiming,
        );
        if (await checkStop()) return;
        if (!result || result.code !== 0) {
          if (!result) {
            await setStage(config, job, "stuck", control, callbacks);
            await notify(
              config,
              job,
              `Watchdog exhausted: ${job.input.branch}`,
              callbacks?.fetchImpl,
              "watchdog",
            );
            return;
          }
          job.error = `implementor exited ${result.code}`;
          job.postBuildPendingPr = false;
          await setStage(config, job, "failed", control, callbacks);
          return;
        }
        if (
          !(await acceptProveEvidenceOrFail(
            config,
            job,
            control,
            "building",
            result.output,
            outputFormat,
            job.input.promptFile,
            callbacks,
            () => {
              job.postBuildPendingPr = false;
            },
          ))
        ) {
          return;
        }
        job.postBuildPendingPr = true;
        await persistJob(config, job, control);
      }

      let pr: Awaited<ReturnType<typeof findPrForBranch>> = null;
      if (!job.dryRun) {
        if (job.prUrl && job.prNumber != null) {
          pr = { url: job.prUrl, number: job.prNumber };
        } else {
          pr = await findPrForBranch(wt, job.input.branch, job.repoSlug);
        }
      }
      let ensurePrError: string | undefined;
      if (!job.dryRun && jobExpectsPr(job.input)) {
        const postBuildLog = async (line: string) => {
          const full = line.startsWith("[runner]") ? line : `[runner] ${line}`;
          await runnerLog(callbacks, job, full);
        };
        const setWait = (detail: NonNullable<JobRecord["statusDetail"]>) => {
          job.statusDetail = detail;
          void persistJob(config, job, control).catch(() => undefined);
        };
        await postBuildLog("post-build: starting commit, push, and PR link");
        job.statusDetail = { phase: "post_build_pr", reason: "post-build: commit/push/PR" };
        await persistJob(config, job, control);
        const ensured = await ensureDraftPrAfterBuild(
          {
            cwd: wt,
            branch: job.input.branch,
            title: job.title || job.input.branch,
            repoSlug: job.repoSlug,
            prUrl: job.prUrl,
          },
          { git: defaultGit, gh: defaultGh },
          {
            log: (line) => void postBuildLog(line),
            onWait: (info) => {
              const until =
                info.untilIso ??
                (info.resetAtEpochSec != null
                  ? new Date(info.resetAtEpochSec * 1000).toISOString()
                  : undefined);
              setWait({
                phase: "post_build_pr",
                reason: info.reason,
                ...(until ? { until } : {}),
              });
            },
          },
        );
        job.statusDetail = null;
        await persistJob(config, job, control);
        if (ensured.ok) {
          pr = ensured.pr;
          await postBuildLog(`opened or adopted draft PR after build: ${pr.url}`);
        } else {
          ensurePrError = ensured.error;
          await postBuildLog(`could not open PR after build: ${ensured.error}`);
        }
      }
      if (!pr) {
        if (!job.dryRun) {
          const noPr = resolvePostBuildNoPr(job.input);
          if (noPr.kind === "complete") {
            job.error = null;
            await setStage(config, job, "approved", control, callbacks);
            await notify(
              config,
              job,
              `Job finished (no PR): ${job.input.branch}`,
              callbacks?.fetchImpl,
            );
            emit(callbacks, job, { type: "done", stage: "approved" });
            return;
          }
          const branchMatchesBase = await branchHasNoCommitsBeyondBase(wt, baseSettings);
          let errorText = resolvePostBuildNoPrError({
            input: job.input,
            ensureError: ensurePrError,
            branchMatchesBase,
          });
          if (errorText === NO_PR_GUARD_MESSAGE) {
            const diagnosis = await diagnosePrSetupIssues(repoRoot);
            errorText = enrichNoPrGuardMessage(errorText, diagnosis);
          }
          job.error = errorText;
          if (isTransientPrEnsureError(ensurePrError)) {
            job.postBuildPendingPr = true;
            await setStage(config, job, "failed", control, callbacks);
            await notify(
              config,
              job,
              `GitHub rate limit opening PR (transient): ${job.input.branch}`,
              callbacks?.fetchImpl,
            );
            return;
          }
          job.postBuildPendingPr = true;
          await setStage(config, job, "stuck", control, callbacks);
          return;
        }
      } else {
        job.prUrl = pr.url;
        job.prNumber = pr.number;
        job.postBuildPendingPr = false;
        await persistJob(config, job, control);
        emit(callbacks, job, { type: "pr", url: pr.url });
        callbacks?.onPrLinked?.(job.id);
        await notify(config, job, `PR opened/updated: ${job.input.branch}`, callbacks?.fetchImpl);
      }
    }

    if (!(await ensurePushedBeforeReview(config, job, wt, control, callbacks))) return;

    if (job.stage === "fixing" && job.prUrl) {
      const ok = await runFixStage(
        runner,
        config,
        job,
        control,
        settings,
        baseSettings,
        wt,
        outputFormat,
        driverEntry,
        callbacks,
      );
      if (!ok) return;
    }

    while (job.reviewRound <= job.maxRounds) {
      if (await checkStop()) return;

      job.reviewRound += 1;
      await setStage(config, job, "reviewing", control, callbacks);
      const reviewBaselineCommentId =
        !job.dryRun && job.prNumber != null
          ? await fetchLatestPrCommentId(wt, job.prNumber)
          : undefined;
      const reviewBaselineReviewId =
        !job.dryRun && job.prNumber != null
          ? await fetchLatestPrReviewId(wt, job.prNumber)
          : undefined;
      const reviewRoundStartedAt = new Date().toISOString();

      const reviewFallback = isDocsJob(job) ? DOCS_REVIEW_PROMPT : DEFAULT_REVIEW_PROMPT;
      const reviewPrompt = await readPromptFile(
        "reviewPromptFile",
        job.input.reviewPromptFile ?? "",
        reviewFallback,
        promptBases(job, wt),
        job,
        callbacks,
      );
      const reviewSteer = control.drainSteer();
      const prLabel = job.dryRun ? "(dry run — simulated PR)" : String(job.prUrl);
      const reviewFull = reviewSteer
        ? `${reviewPrompt}\n\nPR: ${prLabel}\n\n--- steer ---\n${reviewSteer}`
        : `${reviewPrompt}\n\nPR: ${prLabel}`;

      const reviewRun = await runAgentStage(
        runner,
        config,
        job,
        control,
        settings,
        "reviewing",
        {
          cwd: wt,
          prompt: reviewFull,
          model: job.model,
          logPath: job.logPath,
          dryRun: job.dryRun,
          outputFormat,
          signal: control.signal,
          driverId: job.driverId,
          driverEntry,
        },
        callbacks?.watchdogTiming,
      );
      if (await checkStop()) return;
      if (!reviewRun || reviewRun.code !== 0) {
        if (!reviewRun) {
          await setStage(config, job, "stuck", control, callbacks);
          await notify(
            config,
            job,
            `Watchdog exhausted (review): ${job.input.branch}`,
            callbacks?.fetchImpl,
            "watchdog-review",
          );
          return;
        }
        job.error = `reviewer exited ${reviewRun.code}`;
        await setStage(config, job, "failed", control, callbacks);
        return;
      }

      let verdict: Verdict | null = null;
      if (job.dryRun) {
        verdict = job.reviewRound >= job.maxRounds ? "APPROVE" : "CHANGES";
      } else if (job.prNumber != null) {
        const prNumber = job.prNumber;
        const githubVerdict = await fetchPrVerdictSince(wt, prNumber, {
          sinceIso: reviewRoundStartedAt,
          afterCommentId: reviewBaselineCommentId,
          afterReviewId: reviewBaselineReviewId,
        });
        const resolved = await resolveReviewVerdict({
          githubVerdict,
          reviewOutput: reviewRun.output,
          outputFormat,
          mirrorToPr: (body) => postPrComment(wt, prNumber, body),
          log: (line) => runnerLog(callbacks, job, line),
        });
        verdict = resolved?.verdict ?? null;
      }

      if (!verdict) {
        job.error =
          "Reviewer did not post or return VERDICT: APPROVE or VERDICT: CHANGES (checked PR comments, PR reviews, and the reviewer's final message)";
        await setStage(config, job, "failed", control, callbacks);
        return;
      }
      job.lastVerdict = verdict;
      await persistJob(config, job, control);

      if (verdict === "APPROVE") {
        if (!job.dryRun) {
          const prView = await fetchPrViewInfo(wt, {
            prNumber: job.prNumber,
            branch: job.input.branch,
            prUrl: job.prUrl,
          });
          job.approveHeadSha = prView?.headRefOid ?? (await readHeadSha(wt));
        } else {
          job.approveHeadSha = await readHeadSha(wt);
        }
        await setStage(config, job, "approved", control, callbacks);
        await notify(config, job, `Loop approved: ${job.input.branch}`, callbacks?.fetchImpl);
        await persistJob(config, job, control);
        emit(callbacks, job, { type: "done", stage: "approved" });
        callbacks?.onPrLinked?.(job.id);
        return;
      }

      // CHANGES
      if (job.reviewRound >= job.maxRounds) {
        await setStage(config, job, "changes_remaining", control, callbacks);
        await notify(
          config,
          job,
          `Loop ended with changes remaining: ${job.input.branch}`,
          callbacks?.fetchImpl,
        );
        emit(callbacks, job, { type: "done", stage: "changes_remaining" });
        return;
      }

      if (
        !(await runFixStage(
          runner,
          config,
          job,
          control,
          settings,
          baseSettings,
          wt,
          outputFormat,
          driverEntry,
          callbacks,
        ))
      ) {
        return;
      }
      if (await checkStop()) return;
      // loop continues to next review round
    }
  } catch (err) {
    job.error = setJobError(job.error, err instanceof Error ? err.message : String(err));
    await setStage(config, job, "failed", control, callbacks);
    await notify(config, job, `Job failed: ${job.input.branch}`, callbacks?.fetchImpl, "failed");
  } finally {
    if (!job.dryRun && job.worktreePath && (job.stage === "failed" || job.stage === "stopped")) {
      await maybeCleanupJobWorktree(config, job);
    }
  }
}

export async function jobSnapshot(config: RunnerConfig, job: JobRecord) {
  const { enrichJobPublicView } = await import("./job-api-view.js");
  void config;
  return enrichJobPublicView(job, { logTail: await readLogTail(job.logPath) });
}
