import { readFile } from "node:fs/promises";
import type { RunnerConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import {
  fetchLatestPrCommentId,
  fetchPrCommentVerdictSince,
  findPrForBranch,
  isBranchSyncedWithOrigin,
  type Verdict,
} from "./github.js";
import { JobControl } from "./job-control.js";
import { DEFAULT_FIX_PROMPT, DEFAULT_REVIEW_PROMPT } from "./prompts.js";
import { formatJobEmailHtml, sendResendEmail, type FetchFn } from "./resend.js";
import { readLogTail, saveJob } from "./store.js";
import type { JobEvent, JobRecord, JobStage } from "./types.js";
import { cloneRepo, ensureWorktree, rebaseOntoBase, removeWorktree } from "./worktree.js";
import { cursorWorktreeDir } from "./paths.js";

export type JobCallbacks = {
  onEvent?: (jobId: string, event: JobEvent) => void;
  fetchImpl?: FetchFn;
};

async function readPromptFile(filePath: string, fallback: string): Promise<string> {
  if (!filePath?.trim()) return fallback;
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function notify(
  config: RunnerConfig,
  job: JobRecord,
  headline: string,
  fetchImpl?: FetchFn,
): Promise<void> {
  if (!config.notifyEmail || !config.resendApiKey) return;
  const html = formatJobEmailHtml({
    headline,
    prUrl: job.prUrl,
    verdict: job.lastVerdict,
    stage: job.stage,
    jobId: job.id,
  });
  const result = await sendResendEmail(
    config.resendApiKey,
    { to: config.notifyEmail, subject: headline, html },
    fetchImpl,
  );
  if (!result.ok) {
    job.error = job.error ? `${job.error}; email: ${result.error}` : `email: ${result.error}`;
  }
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
  const runner = new AgentRunner();
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
      wt = await ensureWorktree(repoRoot, job.id, job.input.branch);
      job.worktreePath = wt;
      await persistJob(config, job, control);
    }

    // --- building / implementor ---
    if (job.stage === "building" && !job.prUrl) {
      const prompt = await readPromptFile(
        job.input.promptFile,
        "Implement the ticket and open a PR.",
      );
      const steer = control.drainSteer();
      const fullPrompt = steer ? `${prompt}\n\n--- steer ---\n${steer}` : prompt;
      const result = await runner.run({
        cwd: wt,
        prompt: fullPrompt,
        model: job.model,
        logPath: job.logPath,
        dryRun: job.dryRun,
        outputFormat: "stream-json",
        signal: control.signal,
      });
      if (await checkStop()) return;
      if (result.code !== 0) {
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
      await notify(config, job, `PR opened/updated: ${job.input.branch}`, callbacks?.fetchImpl);
    }

    if (!(await ensurePushedBeforeReview(config, job, wt, control, callbacks))) return;

    while (job.reviewRound <= job.maxRounds) {
      if (await checkStop()) return;

      job.reviewRound += 1;
      await setStage(config, job, "reviewing", control, callbacks);
      const reviewBaselineCommentId =
        !job.dryRun && job.prNumber != null
          ? await fetchLatestPrCommentId(wt, job.prNumber)
          : undefined;
      const reviewRoundStartedAt = new Date().toISOString();

      const reviewPrompt = await readPromptFile(
        job.input.reviewPromptFile ?? "",
        DEFAULT_REVIEW_PROMPT,
      );
      const reviewSteer = control.drainSteer();
      const reviewFull = reviewSteer
        ? `${reviewPrompt}\n\nPR: ${job.prUrl}\n\n--- steer ---\n${reviewSteer}`
        : `${reviewPrompt}\n\nPR: ${job.prUrl}`;

      const reviewRun = await runner.run({
        cwd: wt,
        prompt: reviewFull,
        model: job.model,
        logPath: job.logPath,
        dryRun: job.dryRun,
        outputFormat: "stream-json",
        signal: control.signal,
      });
      if (await checkStop()) return;
      if (reviewRun.code !== 0) {
        job.error = `reviewer exited ${reviewRun.code}`;
        await setStage(config, job, "failed", control, callbacks);
        return;
      }

      let verdict: Verdict | null = null;
      if (job.dryRun) {
        verdict = job.reviewRound >= job.maxRounds ? "APPROVE" : "CHANGES";
      } else if (job.prNumber != null) {
        verdict = await fetchPrCommentVerdictSince(wt, job.prNumber, {
          sinceIso: reviewRoundStartedAt,
          afterCommentId: reviewBaselineCommentId,
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
        await setStage(config, job, "approved", control, callbacks);
        await notify(config, job, `Loop approved: ${job.input.branch}`, callbacks?.fetchImpl);
        if (!job.dryRun) {
          await removeWorktree(repoRoot, wt);
        }
        job.worktreePath = null;
        await persistJob(config, job, control);
        emit(callbacks, job, { type: "done", stage: "approved" });
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

      await setStage(config, job, "fixing", control, callbacks);
      if (!job.dryRun) {
        await rebaseOntoBase(wt);
      }
      const fixPrompt = await readPromptFile(job.input.fixPromptFile ?? "", DEFAULT_FIX_PROMPT);
      const fixSteer = control.drainSteer();
      const fixFull = fixSteer
        ? `${fixPrompt}\n\nPR: ${job.prUrl}\n\n--- steer ---\n${fixSteer}`
        : `${fixPrompt}\n\nPR: ${job.prUrl}`;

      const fixRun = await runner.run({
        cwd: wt,
        prompt: fixFull,
        model: job.model,
        logPath: job.logPath,
        dryRun: job.dryRun,
        outputFormat: "stream-json",
        signal: control.signal,
      });
      if (await checkStop()) return;
      if (fixRun.code !== 0) {
        job.error = `fixer exited ${fixRun.code}`;
        await setStage(config, job, "failed", control, callbacks);
        return;
      }
      if (!(await ensurePushedBeforeReview(config, job, wt, control, callbacks))) return;
      if (!job.dryRun) {
        await notify(
          config,
          job,
          `PR pushed after fix round ${job.reviewRound}`,
          callbacks?.fetchImpl,
        );
      }
      // loop continues to next review round
    }
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    await setStage(config, job, "failed", control, callbacks);
  }
}

export async function jobSnapshot(config: RunnerConfig, job: JobRecord) {
  return {
    ...job,
    logTail: await readLogTail(job.logPath),
  };
}
