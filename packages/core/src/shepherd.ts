import { getLocalPr, isArchivedPr, pendingReviewComments } from "./prs.js";
import { runPreflight } from "./learnings.js";
import { ensureRepoGithub } from "./github-ops.js";
import { runCiChecks } from "./ci-runner.js";

export type ShepherdStatus = "ready" | "blocked";

export interface ShepherdBlockReason {
  check: "review" | "preflight" | "github" | "ci";
  message: string;
}

export interface ShepherdResult {
  status: ShepherdStatus;
  reasons: ShepherdBlockReason[];
}

export interface ShepherdOptions {
  /** For testing: skip GitHub check */
  skipGithubCheck?: boolean;
  /** For testing: skip CI checks */
  skipCiCheck?: boolean;
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

  try {
    // 1. Check local review complete (status reviewed/approved, no pending findings)
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

    // 2. Check Learn #18 runPreflight clean
    const preflight = await runPreflight(cwd, pr);
    if (!preflight.passed) {
      for (const issue of preflight.issues) {
        reasons.push({
          check: "preflight",
          message: `Pattern blocked: ${issue.pattern} (matched in ${issue.matchedIn})`,
        });
      }
    }

    // 3. Check gh bind OK for this repo (bound; surface unbound / active≠bound)
    if (!options.skipGithubCheck) {
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
    }

    // 4. Check local CI passes (format, lint, typecheck, test, build)
    if (!options.skipCiCheck) {
      const ciResult = await runCiChecks(cwd);
      if (!ciResult.allPassed) {
        for (const check of ciResult.checks) {
          if (!check.passed) {
            reasons.push({
              check: "ci",
              message: `CI check failed: ${check.name}${check.error ? ` — ${check.error}` : ""}`,
            });
          }
        }
      }
    }
  } catch (err) {
    // Fail-closed: any unknown error becomes blocked
    reasons.push({
      check: "review",
      message: `Failed to check shepherd status: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    status: reasons.length === 0 ? "ready" : "blocked",
    reasons,
  };
}
