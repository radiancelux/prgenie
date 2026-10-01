import type { CiCheckResult } from "./ci-runner.js";
import { normalizeReadyCi, readyCiExecutedCheckNames } from "./ready-ci.js";
import type { ReadyCiRecord } from "./types.js";

const FAIL_FAST = /fail-fast/i;
const READY_SKIP_PREFIX = /^skipped \(ready:\s*/i;

/** Display reason for a check carried from readyCi into the export gate (RAD-144). */
export function formatReadyCarriedSkipReason(reason: string): string {
  const trimmed = reason.trim();
  if (READY_SKIP_PREFIX.test(trimmed)) return trimmed.replace(/\s+$/, "");
  return `skipped (ready: ${trimmed})`;
}

export function normalizeSkipScope(checks: readonly string[]): string[] {
  return [...new Set(checks.map((c) => c.trim()).filter(Boolean))].sort();
}

export function skipScopesEqual(a: readonly string[], b: readonly string[]): boolean {
  const na = normalizeSkipScope(a);
  const nb = normalizeSkipScope(b);
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

export function readyCiPlannedScope(record: ReadyCiRecord): string[] {
  if (record.skipScope?.length) return normalizeSkipScope(record.skipScope);
  if (record.checkSkips?.length) return normalizeSkipScope(record.checkSkips.map((c) => c.name));
  if (record.checks?.length) return normalizeSkipScope(record.checks);
  return [];
}

function isIntentionalReadySkip(reason: string | undefined): boolean {
  if (!reason?.trim()) return false;
  return !FAIL_FAST.test(reason);
}

export interface ReadySkipCarryPlan {
  checksToRun: string[];
  carriedResults: CiCheckResult[];
  /** True when ready skips existed but the gate plan no longer matches skipScope. */
  scopeInvalidated: boolean;
}

/**
 * Decide which export-gate checks can be carried from readyCi without re-running (RAD-144).
 * HEAD mismatch, a dropped recorded check, or a broader plan that no longer matches → fail closed.
 * A named human skip (scope is only those checkSkips) is carried when the gate plan still includes them.
 */
export function planReadySkipCarry(options: {
  readyCi: unknown;
  headSha: string;
  plannedChecks: readonly string[];
}): ReadySkipCarryPlan {
  const record = normalizeReadyCi(options.readyCi);
  const planned = normalizeSkipScope(options.plannedChecks);
  if (!record || record.headSha !== options.headSha) {
    return { checksToRun: planned, carriedResults: [], scopeInvalidated: false };
  }

  // RAD-162-R3: partial readyCi at the same HEAD — run checks that never ran at ready.
  // Named checkSkips stay on the RAD-144 path (scope match / invalidation).
  if (
    (record.outcome === "passed" || record.outcome === "incomplete") &&
    !(record.checkSkips?.length ?? 0)
  ) {
    const executed = new Set(readyCiExecutedCheckNames(record));
    const missing = planned.filter((name) => !executed.has(name));
    if (missing.length > 0) {
      const carriedResults: CiCheckResult[] = [];
      for (const name of planned) {
        if (missing.includes(name)) continue;
        const row = record.checkResults?.find((r) => r.name === name);
        const perCheck = record.checkSkips?.find((s) => s.name === name);
        if (perCheck && isIntentionalReadySkip(perCheck.reason)) {
          carriedResults.push({
            name,
            passed: true,
            skipped: true,
            reason: formatReadyCarriedSkipReason(perCheck.reason),
          });
        } else if (row?.outcome === "passed" || executed.has(name)) {
          carriedResults.push({
            name,
            passed: true,
            reason: "passed at ready (RAD-162)",
          });
        }
      }
      return { checksToRun: missing, carriedResults, scopeInvalidated: false };
    }
  }

  const hasReadySkips = record.outcome === "skipped" || (record.checkSkips?.length ?? 0) > 0;
  if (!hasReadySkips) {
    return { checksToRun: planned, carriedResults: [], scopeInvalidated: false };
  }

  const readyScope = readyCiPlannedScope(record);
  // Empty scope is not "skip the whole gate". A human skip must name checks
  // (ciSkipChecks / Skipped checks:) or inherit a same-HEAD plan. Otherwise re-run.
  if (planned.length > 0 && readyScope.length === 0) {
    return { checksToRun: planned, carriedResults: [], scopeInvalidated: true };
  }
  const namedOnly = normalizeSkipScope((record.checkSkips ?? []).map((skip) => skip.name));
  const namedListIsScope = namedOnly.length > 0 && skipScopesEqual(readyScope, namedOnly);
  const planCoversNamedScope = readyScope.every((name) => planned.includes(name));
  if (readyScope.length > 0 && !skipScopesEqual(readyScope, planned)) {
    // A named list is not a full-plan scope. Carry those checks when the gate
    // plan still includes every one of them, and run the rest. Fail closed
    // when the plan drops a recorded check, or when a broader plan no longer matches.
    if (!(namedListIsScope && planCoversNamedScope)) {
      return { checksToRun: planned, carriedResults: [], scopeInvalidated: true };
    }
  }

  const carriedResults: CiCheckResult[] = [];

  if (
    record.outcome === "skipped" &&
    record.skipReason?.trim() &&
    (!record.checkSkips || record.checkSkips.length === 0)
  ) {
    for (const name of planned) {
      carriedResults.push({
        name,
        passed: true,
        skipped: true,
        reason: formatReadyCarriedSkipReason(record.skipReason),
      });
    }
    return { checksToRun: [], carriedResults, scopeInvalidated: false };
  }

  const checksToRun: string[] = [];
  for (const name of planned) {
    const perCheck = record.checkSkips?.find((s) => s.name === name);
    if (perCheck && isIntentionalReadySkip(perCheck.reason)) {
      carriedResults.push({
        name,
        passed: true,
        skipped: true,
        reason: formatReadyCarriedSkipReason(perCheck.reason),
      });
    } else {
      checksToRun.push(name);
    }
  }

  return { checksToRun, carriedResults, scopeInvalidated: false };
}
