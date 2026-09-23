import { getLocalPr, isArchivedPr, pendingReviewComments } from "./prs.js";
import { runPreflight } from "./learnings.js";
import { ensureRepoGithub } from "./github-ops.js";
import { runCiChecks, type CiCheckResult } from "./ci-runner.js";
import { changedPathsForCi, resolveCiCwd, type CiCheckSelection } from "./ci-select.js";
import { looksLikeStaleFullSuitePlan, resolveCiSelection } from "./ci-select-worktree.js";
import { isAbortError, throwIfAborted, type ProgressCallback } from "./progress.js";

export type ShepherdStatus = "ready" | "blocked";

export interface ShepherdBlockReason {
  check: "review" | "preflight" | "github" | "ci";
  message: string;
}

export interface ShepherdCiEnvUnhealthy {
  message: string;
  fixSteps: string[];
}

export interface ShepherdResult {
  status: ShepherdStatus;
  reasons: ShepherdBlockReason[];
  ciPlan?: CiCheckSelection;
  ciChecks?: CiCheckResult[];
  /** Path local CI ran in (RAD-112). */
  ciCwd?: string;
  /**
   * CI toolchain/setup problem (RAD-92). Soft-surfaced — does not hard-block export by default.
   * Product CI fails still appear in `reasons` with check `ci`.
   */
  ciEnvUnhealthy?: ShepherdCiEnvUnhealthy;
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
  /** Override smart-CI plan (tests) — must not be used to reintroduce full-suite as product default. */
  selection?: CiCheckSelection;
  failFast?: boolean;
  parallel?: boolean;
  /**
   * When true, treat CI env unhealthy as a hard export block (opt-in).
   * Default false — only product CI fails hard-block (RAD-92).
   */
  hardBlockCiEnv?: boolean;
  /** Skip worktree node_modules junction (unit fixtures with exit-script package.json). */
  skipToolchainEnsure?: boolean;
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
  let ciCwd: string | undefined;
  let ciEnvUnhealthy: ShepherdCiEnvUnhealthy | undefined;

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
      const resolvedCwd = resolveCiCwd(cwd, pr.worktreePath);
      ciCwd = resolvedCwd;
      const paths = options.changedPaths ?? (await changedPathsForCi(resolvedCwd, id));
      // Caller-forced selection (tests / resume) wins — never re-select and empty a real plan.
      // RAD-123: otherwise prefer worktree selectCiChecks when the loop edits CI selection
      // (or when the installed plugin plan diverges from the worktree module).
      const selection =
        options.selection ??
        (
          await resolveCiSelection({
            changedPaths: paths,
            worktreePath: pr.worktreePath ?? resolvedCwd,
            primaryPath: cwd,
          })
        ).selection;
      // Never run root pnpm test / full suite from a stale installed or replayed plan.
      // Caller-forced `options.selection` is allowed for unit fixtures only.
      if (!options.selection && looksLikeStaleFullSuitePlan(selection)) {
        throw new Error(
          `Refusing stale full-suite CI plan (RAD-123): checks=${JSON.stringify(selection.checks)} ` +
            `reason=${JSON.stringify(selection.reason)}. Shepherd must use worktree selectCiChecks ` +
            `(scoped packages — never root pnpm test).`,
        );
      }
      const checks =
        options.selection && options.selection.checks.length > 0
          ? options.selection.checks
          : selection.checks;
      const ciResult = await runCiChecks(resolvedCwd, {
        checks,
        selection,
        // Prefer selection's own paths when a caller forced the plan (fixtures stub scripts).
        changedPaths: options.selection?.changedPaths ?? paths,
        onProgress,
        signal,
        failFast: options.failFast,
        parallel: options.parallel,
        skipToolchainEnsure: options.skipToolchainEnsure,
      });
      ciPlan = selection;
      ciChecks = ciResult.checks;
      ciCwd = resolvedCwd;

      const productFails = ciResult.checks.filter(
        (check) => !check.passed && !check.skipped && check.kind !== "env",
      );
      const envFails = ciResult.checks.filter(
        (check) => !check.passed && !check.skipped && check.kind === "env",
      );
      const envUnhealthy = Boolean(ciResult.envUnhealthy) || envFails.length > 0;

      if (envUnhealthy) {
        ciEnvUnhealthy = {
          message:
            ciResult.envMessage ??
            envFails[0]?.excerpt ??
            envFails[0]?.error ??
            "CI environment unhealthy (missing toolchain in worktree).",
          fixSteps: ciResult.fixSteps ?? [],
        };
        onProgress?.({
          phase: "ci",
          state: "fail",
          message: `CI env unhealthy (soft): ${ciEnvUnhealthy.message}`,
          cwd: resolvedCwd,
        });
        if (options.hardBlockCiEnv) {
          reasons.push({
            check: "ci",
            message: `CI environment unhealthy: ${ciEnvUnhealthy.message} (cwd: ${resolvedCwd})`,
          });
        }
      }

      if (productFails.length > 0) {
        for (const check of productFails) {
          reasons.push({
            check: "ci",
            message: `CI check failed: ${check.name}${check.error ? ` — ${check.error}` : ""} (cwd: ${resolvedCwd})`,
          });
        }
      } else if (!envUnhealthy && !ciResult.allPassed) {
        // Fail-closed for unclassified failures (no kind) — treat as product.
        for (const check of ciResult.checks) {
          if (!check.passed && !check.skipped) {
            reasons.push({
              check: "ci",
              message: `CI check failed: ${check.name}${check.error ? ` — ${check.error}` : ""} (cwd: ${resolvedCwd})`,
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
    ciCwd,
    ciEnvUnhealthy,
  };
}
