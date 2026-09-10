import { getLocalPr, isArchivedPr, pendingReviewComments } from "./prs.js";
import { runPreflight } from "./learnings.js";

export interface ExportValidationResult {
  ok: boolean;
  /** Empty when ok, otherwise reasons export is blocked. */
  issues: string[];
}

export interface ExportValidationOptions {
  /** When true, skip all export validation (emergency override). Default false. */
  skipValidation?: boolean;
}

/**
 * Validate that a local PR is ready for export to GitHub.
 * Blocks export until:
 * 1. Local review is complete (status reviewed or approved, no pending comments)
 * 2. Preflight pattern checks pass (Learn #18)
 */
export async function validateExport(
  cwd: string,
  id: string,
  options: ExportValidationOptions = {},
): Promise<ExportValidationResult> {
  if (options.skipValidation) {
    return { ok: true, issues: [] };
  }

  const issues: string[] = [];
  const pr = await getLocalPr(cwd, id);

  // Check review status: must be reviewed or approved (no pending comments)
  if (!isArchivedPr(pr) && pr.status !== "reviewed" && pr.status !== "approved") {
    const pending = pendingReviewComments(pr);
    if (pending.length > 0) {
      issues.push(
        `Review incomplete: ${pending.length} open finding(s). Address each comment, then complete_review.`,
      );
    } else {
      issues.push(
        `Review incomplete: status is ${pr.status}. Set status to ready, complete review, or approve.`,
      );
    }
  }

  // Run preflight pattern checks (Learn #18 integration)
  const preflight = await runPreflight(cwd, pr);
  if (!preflight.passed) {
    for (const issue of preflight.issues) {
      issues.push(
        `Preflight pattern: ${issue.pattern} — ${issue.guidance} (matched in ${issue.matchedIn})`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
