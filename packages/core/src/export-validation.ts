import { getLocalPr, setLocalPrExportGate } from "./prs.js";
import { shepherdStatus, type ShepherdResult } from "./shepherd.js";
import {
  abortError,
  isAbortError,
  onAbort,
  type ProgressCallback,
  type RunProgressOptions,
} from "./progress.js";

export interface ExportValidationResult {
  ok: boolean;
  /** Empty when ok, otherwise reasons export is blocked. */
  issues: string[];
}

export interface ExportValidationOptions extends RunProgressOptions {
  /** When true, skip all export validation (emergency override). Default false. */
  skipValidation?: boolean;
}

type GateFlight = {
  promise: Promise<ShepherdResult>;
  abort: () => void;
  addListener: (cb?: ProgressCallback) => () => void;
};

const inflight = new Map<string, GateFlight>();

function gateKey(cwd: string, id: string, headSha: string): string {
  return `${cwd}\0${id}\0${headSha}`;
}

/**
 * Run the same shepherd aggregator export uses, then persist the snapshot
 * so sidebar/CLI human-export UI shares the gate (RAD-71).
 *
 * Concurrent callers for the same cwd+id+HEAD share one CI run and fan out
 * progress. Abort cancels that shared run and does not persist ready/blocked.
 */
export async function evaluateAndStoreExportGate(
  cwd: string,
  id: string,
  options: RunProgressOptions = {},
): Promise<ShepherdResult> {
  const pr = await getLocalPr(cwd, id);
  const key = gateKey(cwd, id, pr.headSha);
  const existing = inflight.get(key);
  if (existing) {
    const unsub = existing.addListener(options.onProgress);
    const detach = onAbort(options.signal, () => existing.abort());
    try {
      return await existing.promise;
    } finally {
      unsub();
      detach();
    }
  }

  const listeners = new Set<ProgressCallback>();
  if (options.onProgress) listeners.add(options.onProgress);
  const controller = new AbortController();
  const detachCaller = onAbort(options.signal, () => controller.abort());
  const emit: ProgressCallback = (event) => {
    for (const cb of listeners) cb(event);
  };

  const flight: GateFlight = {
    promise: Promise.resolve({ status: "blocked", reasons: [] }),
    abort: () => controller.abort(),
    addListener: (cb) => {
      if (!cb) return () => undefined;
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  const run = (async () => {
    let result: ShepherdResult;
    try {
      result = await shepherdStatus(cwd, id, {
        onProgress: emit,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) throw abortError();
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
      ciPlan: result.ciPlan
        ? {
            checks: result.ciPlan.checks,
            reason: result.ciPlan.reason,
            uncertain: result.ciPlan.uncertain,
          }
        : null,
      ciChecks: result.ciChecks ?? null,
    });
    return result;
  })();

  flight.promise = run;
  inflight.set(key, flight);
  try {
    return await run;
  } finally {
    detachCaller();
    inflight.delete(key);
  }
}

export function abortExportGate(cwd: string, id: string, headSha: string): boolean {
  const flight = inflight.get(gateKey(cwd, id, headSha));
  if (!flight) return false;
  flight.abort();
  return true;
}

export function exportGateInFlight(cwd: string, id: string, headSha: string): boolean {
  return inflight.has(gateKey(cwd, id, headSha));
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
  const shepherd = await evaluateAndStoreExportGate(cwd, id, {
    onProgress: options.onProgress,
    signal: options.signal,
  });

  if (shepherd.status === "ready") {
    return { ok: true, issues: [] };
  }

  return { ok: false, issues: issuesFromShepherd(shepherd) };
}
