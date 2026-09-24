import { acquireCiLock, requestCiAbort, watchCiAbort } from "./ci-abort.js";
import { exportGateSnapshotIsAdoptable, pendingExportGate } from "./export-gate.js";
import { looksLikeStaleFullSuitePlan } from "./ci-select-worktree.js";
import { getLocalPr, refreshLocalPrHead, setLocalPrExportGate } from "./prs.js";
import { shepherdStatus, type ShepherdResult } from "./shepherd.js";
import {
  abortError,
  isAbortError,
  onAbort,
  throwIfAborted,
  type ProgressCallback,
  type ProgressEvent,
  type RunProgressOptions,
} from "./progress.js";
import type { ExportGateSnapshot } from "./types.js";

export interface ExportValidationResult {
  ok: boolean;
  /** Empty when ok, otherwise reasons export is blocked. */
  issues: string[];
  /**
   * Soft env/toolchain problem from shepherd (RAD-92 / RAD-95).
   * Surfaced even when export is otherwise ready so skipValidation is not required to see it.
   */
  ciEnvUnhealthy?: {
    message: string;
    fixSteps: string[];
  };
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

function snapshotIsAdoptable(
  snap: ExportGateSnapshot | null | undefined,
  headSha: string,
): boolean {
  // RAD-123: never peer-replay / validate-from-store a stale root full-suite plan.
  return exportGateSnapshotIsAdoptable(snap, headSha);
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
    ciEnvUnhealthy: snap.ciEnvUnhealthy
      ? {
          message: snap.ciEnvUnhealthy.message,
          fixSteps: snap.ciEnvUnhealthy.fixSteps ?? [],
        }
      : undefined,
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
    /** Override smart-CI path list (tests). */
    changedPaths?: string[];
    /** Override smart-CI plan (tests). */
    selection?: import("./ci-select.js").CiCheckSelection;
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
    // RAD-94: same declared-base gate as ready / run_ci / export.
    const { assertDeclaredBaseAligned } = await import("./base-ref.js");
    await assertDeclaredBaseAligned(cwd, pr);
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
    /** Replay buffer so a concurrent joiner still sees CI starts that already fired. */
    const recent: ProgressEvent[] = [];
    if (options.onProgress) listeners.add(options.onProgress);
    const emit: ProgressCallback = (event) => {
      recent.push(event);
      for (const cb of listeners) cb(event);
    };

    const flight: GateFlight = {
      promise: Promise.resolve({ status: "blocked", reasons: [] }),
      abort: () => controller.abort(),
      addListener: (cb) => {
        if (!cb) return () => undefined;
        listeners.add(cb);
        for (const event of recent) cb(event);
        return () => {
          listeners.delete(cb);
        };
      },
    };

    // Claim the flight before any await in `run` so a concurrent caller joins
    // instead of starting a second evaluation (JS can interleave at the first await).
    inflight.set(key, flight);
    const run = (async () => {
      let lock = await acquireCiLock(cwd, id, pr.headSha, controller.signal);
      try {
        while (lock.peerDone) {
          throwIfAborted(controller.signal);
          const latest = await getLocalPr(cwd, id);
          const peerSnap = latest.exportGate;
          if (peerSnap && snapshotIsAdoptable(peerSnap, pr.headSha)) {
            return shepherdFromSnapshot(peerSnap);
          }
          // Peer wrote a stale full-suite plan (or incomplete gate) — invalidate and re-run (RAD-123).
          const peerPlan = peerSnap?.ciPlan ?? null;
          if (
            peerSnap != null &&
            peerSnap.headSha === pr.headSha &&
            peerPlan != null &&
            looksLikeStaleFullSuitePlan({
              checks: peerPlan.checks,
              reason: peerPlan.reason,
            })
          ) {
            emit({
              phase: "ci",
              state: "fail",
              message:
                "RAD-123: refusing peer snapshot with stale full-suite CI plan — re-running with worktree selectCiChecks",
            });
            await setLocalPrExportGate(cwd, id, pendingExportGate(pr.headSha));
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
            changedPaths: options.changedPaths,
            selection: options.selection,
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
        // Never persist a stale root full-suite plan for peer replay (RAD-123).
        if (result.ciPlan && looksLikeStaleFullSuitePlan(result.ciPlan) && !options.selection) {
          result = {
            status: "blocked",
            reasons: [
              {
                check: "ci",
                message:
                  `Refusing stale full-suite CI plan (RAD-123): checks=${JSON.stringify(result.ciPlan.checks)} ` +
                  `reason=${JSON.stringify(result.ciPlan.reason)}. Export gate must use worktree selectCiChecks ` +
                  `(scoped core/cli — never root pnpm test). Rebuild/relink the plugin from the loop worktree.`,
              },
            ],
            ciPlan: undefined,
            ciChecks: undefined,
            ciCwd: result.ciCwd,
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
          ciEnvUnhealthy: result.ciEnvUnhealthy
            ? {
                message: result.ciEnvUnhealthy.message,
                fixSteps: result.ciEnvUnhealthy.fixSteps,
              }
            : null,
        });
        return result;
      } finally {
        lock.release();
      }
    })();

    flight.promise = run;
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
 * `shepherd_status` / `steward_next` (other processes) stop too.
 * Prefer `abortCiForSteward` for panel Cancel / MCP `abort_ci` (RAD-115) — that
 * also returns the bound implementor Task id for the skip half.
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
 * Loop panel Cancel and MCP `abort_ci` both call this (RAD-115). Cancel is the
 * skip half — abort alone does not kill the agent; callers must still
 * stop/interrupt `implementorTaskId` when stewardAction says so.
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

  // Prefer a complete stored gate for this HEAD (RAD-71 / RAD-119). Re-running
  // selectCiChecks can intentionally skip local CI while a prior blocked plan
  // still names the failing check — do not greenwash or drop those reasons.
  // RAD-123: never adopt a stale full-suite snapshot (forces re-evaluate).
  const pr = await refreshLocalPrHead(cwd, id);
  // RAD-94: fail export when merge-base ≠ declared base (or ahead-of-base is stacked).
  const { assertDeclaredBaseAligned } = await import("./base-ref.js");
  try {
    await assertDeclaredBaseAligned(cwd, pr);
  } catch (err) {
    return {
      ok: false,
      issues: [err instanceof Error ? err.message : String(err)],
    };
  }
  if (pr.exportGate && snapshotIsAdoptable(pr.exportGate, pr.headSha)) {
    const fromStore = shepherdFromSnapshot(pr.exportGate);
    if (fromStore.status === "ready") {
      return { ok: true, issues: [], ciEnvUnhealthy: fromStore.ciEnvUnhealthy };
    }
    return {
      ok: false,
      issues: issuesFromShepherd(fromStore),
      ciEnvUnhealthy: fromStore.ciEnvUnhealthy,
    };
  }

  // No stored gate yet — same shepherd run the UI gate persists.
  const shepherd = await evaluateAndStoreExportGate(cwd, id, {
    onProgress: options.onProgress,
    signal: options.signal,
  });

  if (shepherd.status === "ready") {
    return { ok: true, issues: [], ciEnvUnhealthy: shepherd.ciEnvUnhealthy };
  }

  return {
    ok: false,
    issues: issuesFromShepherd(shepherd),
    ciEnvUnhealthy: shepherd.ciEnvUnhealthy,
  };
}
