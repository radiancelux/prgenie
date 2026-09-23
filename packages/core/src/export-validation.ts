import { acquireCiLock, requestCiAbort, watchCiAbort } from "./ci-abort.js";
import { getLocalPr, refreshLocalPrHead, setLocalPrExportGate } from "./prs.js";
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
            reason: snap.ciPlan?.reason.join("; ") ?? "",
          })),
          uncertain: snap.ciPlan.uncertain ?? false,
          changedPaths: [],
        }
      : undefined,
    ciChecks: snap.ciChecks ?? undefined,
    ciCwd: snap.ciCwd ?? undefined,
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
  options: RunProgressOptions & {
    skipToolchainEnsure?: boolean;
    skipGithubCheck?: boolean;
    skipCiCheck?: boolean;
    hardBlockCiEnv?: boolean;
    /** Forwarded to shepherd/CI (tests): avoid process.env races under parallel node:test. */
    failFast?: boolean;
    parallel?: boolean;
  } = {},
): Promise<ShepherdResult> {
  const controller = new AbortController();
  const detachCaller = onAbort(options.signal, () => {
    controller.abort();
    requestAbortQuiet(cwd, id);
  });
  // Arm before any await so Cancel during getLocalPr still lands.
  const stopWatch = watchCiAbort(cwd, id, controller);
  try {
    throwIfAborted(controller.signal);
    // Refresh HEAD before keying the flight / storing the gate — otherwise a
    // commit made just before shepherd leaves exportGate.headSha stale while
    // changedPathsForCi already sees the new tip (RAD-117 CI-resume).
    const pr = await refreshLocalPrHead(cwd, id);
    throwIfAborted(controller.signal);
    const key = gateKey(cwd, id, pr.headSha);
    const existing = inflight.get(key);
    if (existing) {
      const unsub = existing.addListener(options.onProgress);
      const detach = onAbort(options.signal, () => {
        existing.abort();
        requestAbortQuiet(cwd, id);
      });
      try {
        if (controller.signal.aborted) existing.abort();
        return await existing.promise;
      } finally {
        unsub();
        detach();
      }
    }

    const listeners = new Set<ProgressCallback>();
    if (options.onProgress) listeners.add(options.onProgress);
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
            skipToolchainEnsure: options.skipToolchainEnsure,
            skipGithubCheck: options.skipGithubCheck,
            skipCiCheck: options.skipCiCheck,
            hardBlockCiEnv: options.hardBlockCiEnv,
            failFast: options.failFast,
            parallel: options.parallel,
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
          ciCwd: result.ciCwd ?? null,
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
      inflight.delete(key);
    }
  } finally {
    stopWatch();
    detachCaller();
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

export type AbortCiStewardAction = "stop_implementor_and_abort_ci" | "abort_ci_only";

export interface AbortCiResult {
  aborted: boolean;
  /** Bound implementor Task id when a steward owns this loop (RAD-112). */
  implementorTaskId: string | null;
  /**
   * Human/steward CI skip must stop the implementor Task and abort CI together.
   * abort_ci alone leaves the implementor looping on the stale suite.
   */
  stewardAction: AbortCiStewardAction;
  message: string;
}

/**
 * Abort in-flight CI and return the steward action for a human/steward CI skip.
 * Callers must also stop/interrupt `implementorTaskId` when stewardAction says so.
 */
export async function abortCiForSteward(
  cwd: string,
  id: string,
  headSha?: string,
): Promise<AbortCiResult> {
  const aborted = abortExportGate(cwd, id, headSha);
  const { getStewardBinding } = await import("./steward.js");
  let implementorTaskId: string | null = null;
  try {
    const binding = await getStewardBinding(cwd, id);
    implementorTaskId = binding?.implementorTaskId ?? null;
  } catch {
    // Loop may lack a steward binding — abort still applies.
  }
  if (implementorTaskId) {
    return {
      aborted,
      implementorTaskId,
      stewardAction: "stop_implementor_and_abort_ci",
      message:
        `CI aborted. Also stop/interrupt implementor Task ${implementorTaskId} ` +
        `(abort_ci alone leaves that Task looping on CI). Do not resume run_ci unless the human asks.`,
    };
  }
  return {
    aborted,
    implementorTaskId: null,
    stewardAction: "abort_ci_only",
    message: "CI aborted.",
  };
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
