import { shepherdStatus } from "./shepherd.js";

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
 * Uses shepherdStatus aggregator to check: review + preflight + gh bind + CI.
 * Blocks export unless all checks pass.
 */
export async function validateExport(
  cwd: string,
  id: string,
  options: ExportValidationOptions = {},
): Promise<ExportValidationResult> {
  if (options.skipValidation) {
    return { ok: true, issues: [] };
  }

  // Use shepherd aggregator for all checks (production: never skip CI or GitHub)
  const shepherd = await shepherdStatus(cwd, id, {});

  if (shepherd.status === "ready") {
    return { ok: true, issues: [] };
  }

  // Convert shepherd reasons to export validation issues
  const issues = shepherd.reasons.map((reason) => {
    const prefix =
      reason.check === "review"
        ? "Review"
        : reason.check === "preflight"
          ? "Preflight"
          : reason.check === "github"
            ? "GitHub"
            : reason.check === "ci"
              ? "CI"
              : "Check";
    return `${prefix}: ${reason.message}`;
  });

  return { ok: false, issues };
}
