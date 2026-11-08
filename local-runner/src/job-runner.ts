import { readFile } from "node:fs/promises";
import type { RunnerConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import {
  fetchLatestPrCommentId,
  fetchLatestPrReviewId,
  fetchPrVerdictSince,
  findPrForBranch,
  isBranchSyncedWithOrigin,
  type Verdict,
} from "./github.js";
import { JobControl } from "./job-control.js";
import { DEFAULT_FIX_PROMPT, DEFAULT_IMPLEMENT_PROMPT, DEFAULT_REVIEW_PROMPT } from "./prompts.js";
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
import { readLogTail, saveJob } from "./store.js";
import type { JobEvent, JobRecord, JobStage } from "./types.js";
import { sumTokenUsageFromLog } from "./usage.js";
import { cloneRepo, ensureWorktree, rebaseOntoBase } from "./worktree.js";
import { cursorWorktreeDir } from "./paths.js";
import { fetchPrViewInfo, readHeadSha } from "./draft-pr.js";
import { runAgentWithWatchdog, type StageWatchdogOptions } from "./stage-watchdog.js";
import { isComputeJob } from "./job-type-watchdog.js";
import { createProcessActivitySampler } from "./watchdog-process-activity.js";
import { trackShellToolLine, type ShellToolTracker } from "./stream-json-log.js";
import { modelForActiveStage, recordActualModel } from "./job-models.js";
import { setJobError } from "./job-error.js";
import { parseWatchdogPolicy } from "./runner-policy.js";

export type JobCallbacks = {
  onEvent?: (jobId: string, event: JobEvent) => void;
  onPrLinked?: (jobId: string) => void;
  fetchImpl?: FetchFn;
  agentRunner?: AgentRunner;
  watchdogTiming?: WatchdogTiming;
};

type WatchdogTiming = Pick<StageWatchdogOptions, "now" | "tickMs" | "childGraceMs">;

async function readPromptFile(filePath: string, fallback: string): Promise<string> {
  if (!filePath?.trim()) return fallback;
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
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
  const policy = watchdogPolicyForJob(job, settings);
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
  recordActualModel(
    job,
    stage === "building" ? "build" : stage === "reviewing" ? "review" : "fix",
    model,
  );
  // The serve-side supervisor budgets detached workers per stage from the on-disk clock.
  await persistJob(config, job, control);

  const clock = timing?.now ?? Date.now;
  const wd = await runAgentWithWatchdog(
    {
      ...timing,
      policy,
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

async function persistJob(
  config: RunnerConfig,
  job: JobRecord,
  control: JobControl,
): Promise<void> {
  JobControl.syncSteerQueueForPersist(job, control);
  const usage = await sumTokenUsageFromLog(job.logPath);
  if (usage) job.tokenUsage = usage;
  await saveJob(config.dataDir, job);
}

async function setStage(
  config: RunnerConfig,
  job: JobRecord,
  stage: JobStage,
  control: JobControl,
  cb?: JobCallbacks,
): Promise<void> {
  job.stage = stage;
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
    await rebaseOntoBase(wt, baseSettings);
  }
  const fixDefault = isDocsJob(job) ? resolveDocsFixPrompt() : DEFAULT_FIX_PROMPT;
  const fixPrompt = await readPromptFile(job.input.fixPromptFile ?? "", fixDefault);
  const fixSteer = control.drainSteer();
  const fixFull = fixSteer
    ? `${fixPrompt}\n\nPR: ${job.prUrl}\n\n--- steer ---\n${fixSteer}`
    : `${fixPrompt}\n\nPR: ${job.prUrl}`;

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
  const sync = await isBranchSyncedWithOrigin(wt, job.input.branch);
  if (sync.ok) return true;
  job.error = `Branch not pushed to origin before review: ${sync.reason}`;
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
      wt = await ensureWorktree(repoRoot, job.id, job.input.branch, baseSettings);
      job.worktreePath = wt;
      await persistJob(config, job, control);
    }

    // --- building / implementor ---
    if (job.stage === "building" && !job.prUrl) {
      let prompt: string;
      if (isDocsJob(job)) {
        const template = isDocsTemplateId(job.input.docsTemplate) ? job.input.docsTemplate : null;
        const fallback = resolveDocsImplementPrompt(template);
        prompt = await readPromptFile(job.input.promptFile, fallback);
      } else {
        prompt = await readPromptFile(job.input.promptFile, DEFAULT_IMPLEMENT_PROMPT);
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
        await setStage(config, job, "failed", control, callbacks);
        return;
      }

      let pr = await findPrForBranch(wt, job.input.branch);
      if (job.dryRun && !pr) {
        pr = { url: "https://github.com/example/example/pull/1", number: 1 };
      }
      if (!pr) {
        job.error = "No GitHub PR for branch — local-only diff guard";
        await setStage(config, job, "stuck", control, callbacks);
        return;
      }
      job.prUrl = pr.url;
      job.prNumber = pr.number;
      await persistJob(config, job, control);
      emit(callbacks, job, { type: "pr", url: pr.url });
      callbacks?.onPrLinked?.(job.id);
      await notify(config, job, `PR opened/updated: ${job.input.branch}`, callbacks?.fetchImpl);
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
      const reviewPrompt = await readPromptFile(job.input.reviewPromptFile ?? "", reviewFallback);
      const reviewSteer = control.drainSteer();
      const reviewFull = reviewSteer
        ? `${reviewPrompt}\n\nPR: ${job.prUrl}\n\n--- steer ---\n${reviewSteer}`
        : `${reviewPrompt}\n\nPR: ${job.prUrl}`;

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
        verdict = await fetchPrVerdictSince(wt, job.prNumber, {
          sinceIso: reviewRoundStartedAt,
          afterCommentId: reviewBaselineCommentId,
          afterReviewId: reviewBaselineReviewId,
        });
      }

      if (!verdict) {
        job.error = "Reviewer did not post VERDICT: APPROVE or VERDICT: CHANGES";
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
  }
}

export async function jobSnapshot(config: RunnerConfig, job: JobRecord) {
  return {
    ...job,
    logTail: await readLogTail(job.logPath),
  };
}
