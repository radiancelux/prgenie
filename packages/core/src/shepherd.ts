import { getLocalPr, isArchivedPr, pendingReviewComments } from "./prs.js";
import { runPreflight } from "./learnings.js";
import { ensureRepoGithub } from "./github-ops.js";
import { runCiChecks, type CiCheckResult } from "./ci-runner.js";
import {
  changedPathsForCi,
  resolveCiCwd,
  selectCiChecks,
  type CiCheckSelection,
} from "./ci-select.js";
import { isAbortError, throwIfAborted, type ProgressCallback } from "./progress.js";

export type ShepherdStatus = "ready" | "blocked";

export interface ShepherdBlockReason {
  check: "review" | "preflight" | "github" | "ci";
  message: string;
}

export interface ShepherdResult {
  status: ShepherdStatus;
  reasons: ShepherdBlockReason[];
  ciPlan?: CiCheckSelection;
  ciChecks?: CiCheckResult[];
}

export interface ShepherdOptions {
  /** For testing: skip GitHub check */
  skipGithubCheck?: boolean;
  /** For testing: skip CI checks */
  skipCiCheck?: boolean;
  /** Live progress for CLI / sidebar (RAD-73). */
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  /** Override smart-CI path list (tests). */
  changedPaths?: string[];
  failFast?: boolean;
  parallel?: boolean;
}

/**
 * Aggregate shepherd gate: review + Learn #18 preflight + gh bind.
 * Fail-closed: any unknown/missing piece → blocked with explicit reason.
 */
export async function shepherdStatus(
  cwd: string,
  id: string,
  options: ShepherdOptions = {},
): Promise<ShepherdResult> {
  const reasons: ShepherdBlockReason[] = [];
  const onProgress = options.onProgress;
  const signal = options.signal;
  let ciPlan: CiCheckSelection | undefined;
  let ciChecks: CiCheckResult[] | undefined;

  try {
    throwIfAborted(signal);
    // 1. Check local review complete (status reviewed/approved, no pending findings)
    const reviewStarted = Date.now();
    onProgress?.({ phase: "review", state: "start" });
    const pr = await getLocalPr(cwd, id);

    if (!isArchivedPr(pr) && pr.status !== "reviewed" && pr.status !== "approved") {
      const pending = pendingReviewComments(pr);
      if (pending.length > 0) {
        reasons.push({
          check: "review",
          message: `Review incomplete: ${pending.length} open finding(s)`,
        });
      } else if (pr.status === "draft") {
        reasons.push({
          check: "review",
          message: "Status is draft (not ready for review)",
        });
      } else if (pr.status === "ready") {
        reasons.push({
          check: "review",
          message: "Review not started (status is ready)",
        });
      } else if (pr.status === "changes_requested") {
        reasons.push({
          check: "review",
          message: "Changes requested (review not complete)",
        });
      }
    }
    if (reasons.some((r) => r.check === "review")) {
      const first = reasons.find((r) => r.check === "review");
      onProgress?.({
        phase: "review",
        state: "fail",
        elapsedMs: Date.now() - reviewStarted,
        message: first?.message,
      });
    } else {
      onProgress?.({ phase: "review", state: "pass", elapsedMs: Date.now() - reviewStarted });
    }

    throwIfAborted(signal);
    // 2. Check Learn #18 runPreflight clean
    const preflightStarted = Date.now();
    onProgress?.({ phase: "preflight", state: "start" });
    const preflight = await runPreflight(cwd, pr);
    if (!preflight.passed) {
      for (const issue of preflight.issues) {
        reasons.push({
          check: "preflight",
          message: `Pattern blocked: ${issue.pattern} (matched in ${issue.matchedIn})`,
        });
      }
    }
    onProgress?.({
      phase: "preflight",
      state: preflight.passed ? "pass" : "fail",
      elapsedMs: Date.now() - preflightStarted,
      message: preflight.passed ? undefined : preflight.issues[0]?.pattern,
    });

    throwIfAborted(signal);
    // 3. Check gh bind OK for this repo (bound; surface unbound / active≠bound)
    if (!options.skipGithubCheck) {
      const ghStarted = Date.now();
      onProgress?.({ phase: "github", state: "start", command: "gh auth status" });
      const ghState = await ensureRepoGithub(cwd);
      if (!ghState.login) {
        reasons.push({
          check: "github",
          message: "No GitHub account logged in (run: gh auth login)",
        });
      } else if (!ghState.bound) {
        reasons.push({
          check: "github",
          message: `Repo not bound to GitHub account (run: prgenie gh use ${ghState.login})`,
        });
      }
      const ghBlocked = reasons.some((r) => r.check === "github");
      onProgress?.({
        phase: "github",
        state: ghBlocked ? "fail" : "pass",
        elapsedMs: Date.now() - ghStarted,
        command: "gh auth status",
        message: ghBlocked ? reasons.find((r) => r.check === "github")?.message : undefined,
      });
    } else {
      onProgress?.({ phase: "github", state: "skip" });
    }

    throwIfAborted(signal);
    // 4. Check local CI passes (smart-selected format/lint/typecheck/test/build)
    if (!options.skipCiCheck) {
      const ciCwd = resolveCiCwd(cwd, pr.worktreePath);
      const paths = options.changedPaths ?? (await changedPathsForCi(ciCwd, id));
      const selection = selectCiChecks(paths);
      const ciResult = await runCiChecks(ciCwd, {
        checks: selection.checks,
        selection,
        onProgress,
        signal,
        failFast: options.failFast,
        parallel: options.parallel,
      });
      ciPlan = selection;
      ciChecks = ciResult.checks;
      if (!ciResult.allPassed) {
        for (const check of ciResult.checks) {
          if (!check.passed && !check.skipped) {
            reasons.push({
              check: "ci",
              message: `CI check failed: ${check.name}${check.error ? ` — ${check.error}` : ""}`,
            });
          }
        }
      }
    } else {
      onProgress?.({ phase: "ci", state: "skip" });
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Fail-closed: any unknown error becomes blocked
    reasons.push({
      check: "review",
      message: `Failed to check shepherd status: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    status: reasons.length === 0 ? "ready" : "blocked",
    reasons,
    ciPlan,
    ciChecks,
  };
}
