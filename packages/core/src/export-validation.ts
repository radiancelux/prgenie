import { acquireCiLock, requestCiAbort, watchCiAbort } from "./ci-abort.js";
import { getLocalPr, setLocalPrExportGate } from "./prs.js";
import { shepherdStatus, type ShepherdResult } from "./shepherd.js";
import {
  abortError,
  isAbortError,
  onAbort,
  throwIfAborted,
  type ProgressCallback,
  type RunProgressOptions,
} from "./progress.js";
import type { ExportGateSnapshot } from "./types.js";

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

function requestAbortQuiet(cwd: string, id: string): void {
  try {
    requestCiAbort(cwd, id);
  } catch {
    // not a git repo / cannot write the token
  }
}

function snapshotIsComplete(
  snap: ExportGateSnapshot | null | undefined,
  headSha: string,
): snap is ExportGateSnapshot {
  return Boolean(
    snap &&
    snap.headSha === headSha &&
    snap.evaluatedAt &&
    (snap.status === "ready" || snap.status === "blocked"),
  );
}

function shepherdFromSnapshot(snap: ExportGateSnapshot): ShepherdResult {
  return {
    status: snap.status === "ready" ? "ready" : "blocked",
    reasons: snap.reasons,
    ciPlan: snap.ciPlan
      ? {
          checks: snap.ciPlan.checks,
          reason: snap.ciPlan.reason,
          mapping: snap.ciPlan.checks.map((check) => ({
            check,
            reason: snap.ciPlan?.reason ?? "",
          })),
          uncertain: snap.ciPlan.uncertain ?? false,
          changedPaths: [],
        }
      : undefined,
    ciChecks: snap.ciChecks ?? undefined,
  };
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
    const detach = onAbort(options.signal, () => {
      existing.abort();
      requestAbortQuiet(cwd, id);
    });
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
  const detachCaller = onAbort(options.signal, () => {
    controller.abort();
    requestAbortQuiet(cwd, id);
  });
  const stopWatch = watchCiAbort(cwd, id, controller);
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
    let lock = await acquireCiLock(cwd, id, pr.headSha, controller.signal);
    try {
      while (lock.peerDone) {
        throwIfAborted(controller.signal);
        const latest = await getLocalPr(cwd, id);
        if (snapshotIsComplete(latest.exportGate, pr.headSha)) {
          return shepherdFromSnapshot(latest.exportGate);
        }
        lock.release();
        lock = await acquireCiLock(cwd, id, pr.headSha, controller.signal);
      }
      throwIfAborted(controller.signal);
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
    } finally {
      lock.release();
    }
  })();

  flight.promise = run;
  inflight.set(key, flight);
  try {
    return await run;
  } finally {
    stopWatch();
    detachCaller();
    inflight.delete(key);
  }
}

/**
 * Cancel in-process gate CI and bump the file abort token so MCP `run_ci` /
 * `shepherd_status` / `steward_next` (other processes) stop too. Panel Cancel
 * and MCP `abort_ci` share this path.
 */
export function abortExportGate(cwd: string, id: string, headSha?: string): boolean {
  let hit = false;
  if (headSha) {
    const flight = inflight.get(gateKey(cwd, id, headSha));
    if (flight) {
      flight.abort();
      hit = true;
    }
  } else {
    const prefix = `${cwd}\0${id}\0`;
    for (const [key, flight] of inflight) {
      if (key.startsWith(prefix)) {
        flight.abort();
        hit = true;
      }
    }
  }
  try {
    requestCiAbort(cwd, id);
    hit = true;
  } catch {
    // ignore write failures — in-memory abort still counts
  }
  return hit;
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
