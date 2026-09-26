import type { CiCheckResult } from "./ci-runner.js";
import { normalizeReadyCi } from "./ready-ci.js";
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
 * HEAD mismatch or skip-scope change → fail closed (re-run everything).
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
  if (readyScope.length > 0 && !skipScopesEqual(readyScope, planned)) {
    return { checksToRun: planned, carriedResults: [], scopeInvalidated: true };
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
