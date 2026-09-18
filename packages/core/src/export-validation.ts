import { getLocalPr, setLocalPrExportGate } from "./prs.js";
import { shepherdStatus, type ShepherdResult } from "./shepherd.js";

export interface ExportValidationResult {
  ok: boolean;
  /** Empty when ok, otherwise reasons export is blocked. */
  issues: string[];
}

export interface ExportValidationOptions {
  /** When true, skip all export validation (emergency override). Default false. */
  skipValidation?: boolean;
}

const inflight = new Map<string, Promise<ShepherdResult>>();

/**
 * Run the same shepherd aggregator export uses, then persist the snapshot
 * so sidebar/CLI human-export UI shares the gate (RAD-71).
 */
export async function evaluateAndStoreExportGate(cwd: string, id: string): Promise<ShepherdResult> {
  const pr = await getLocalPr(cwd, id);
  const key = `${cwd}\0${id}\0${pr.headSha}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const run = (async () => {
    let result: ShepherdResult;
    try {
      result = await shepherdStatus(cwd, id, {});
    } catch (err) {
      result = {
        status: "blocked",
        reasons: [
          {
            check: "review",
            message: `Failed to check shepherd status: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
    await setLocalPrExportGate(cwd, id, {
      status: result.status,
      reasons: result.reasons,
      headSha: pr.headSha,
      evaluatedAt: new Date().toISOString(),
    });
    return result;
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

function issuesFromShepherd(shepherd: ShepherdResult): string[] {
  return shepherd.reasons.map((reason) => {
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

  // Same shepherd run the UI gate persists — never skip CI/GitHub in production.
  const shepherd = await evaluateAndStoreExportGate(cwd, id);

  if (shepherd.status === "ready") {
    return { ok: true, issues: [] };
  }

  return { ok: false, issues: issuesFromShepherd(shepherd) };
}
