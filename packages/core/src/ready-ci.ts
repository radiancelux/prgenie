import type { CiRunnerResult } from "./ci-runner.js";
import { formatCiSelectionReason } from "./ci-select.js";
import { normalizeSkipScope } from "./ready-skip-carry.js";
import type { LocalPr, LocalPrComment, ReadyCiCheckSkip, ReadyCiRecord } from "./types.js";

const FAIL_FAST = /fail-fast/i;

function isIntentionalReadySkip(reason: string | undefined): boolean {
  if (!reason?.trim()) return false;
  return !FAIL_FAST.test(reason);
}

function intentionalCheckSkips(result: CiRunnerResult): ReadyCiCheckSkip[] {
  return result.checks
    .filter((c) => c.skipped && isIntentionalReadySkip(c.reason))
    .map((c) => ({ name: c.name, reason: c.reason!.trim() }));
}

const CI_SKIP_BODY = /^CI skipped:\s*(.+)$/i;
const CI_SKIP_FIRST_LINE = /^CI skipped:\s*([^\n]+)/i;
const SKIPPED_CHECKS_LINE = /Skipped checks:\s*([^\n]+)/gi;

/** Parse an explicit "CI skipped: <reason>" body (RAD-97). First line only. */
export function parseCiSkipReason(body: string): string | null {
  const match = CI_SKIP_FIRST_LINE.exec(body.trim());
  if (!match) return null;
  const reason = match[1]?.trim();
  return reason ? reason : null;
}

/** Check names from a `Skipped checks:` line (backticks optional). */
export function parseNamedSkipChecks(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(SKIPPED_CHECKS_LINE)) {
    for (const part of match[1].split(",")) {
      const name = part.replace(/`/g, "").trim();
      if (name) names.push(name);
    }
  }
  return normalizeSkipScope(names);
}

export function formatCiSkipBody(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("CI skip reason is empty");
  if (CI_SKIP_BODY.test(trimmed)) return trimmed.replace(/\s+$/, "");
  return `CI skipped: ${trimmed}`;
}

export function normalizeReadyCi(raw: unknown): ReadyCiRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  if (typeof parsed.headSha !== "string" || !parsed.headSha) return null;
  if (parsed.outcome !== "passed" && parsed.outcome !== "skipped") return null;
  const checks = Array.isArray(parsed.checks)
    ? parsed.checks.filter((c): c is string => typeof c === "string")
    : undefined;
  const skipScope = Array.isArray(parsed.skipScope)
    ? parsed.skipScope.filter((c): c is string => typeof c === "string")
    : undefined;
  const checkSkips: ReadyCiCheckSkip[] = [];
  if (Array.isArray(parsed.checkSkips)) {
    for (const row of parsed.checkSkips) {
      if (!row || typeof row !== "object") continue;
      const name = (row as ReadyCiCheckSkip).name;
      const reason = (row as ReadyCiCheckSkip).reason;
      if (typeof name === "string" && name && typeof reason === "string" && reason.trim()) {
        checkSkips.push({ name, reason: reason.trim() });
      }
    }
  }
  return {
    headSha: parsed.headSha,
    recordedAt:
      typeof parsed.recordedAt === "string" && parsed.recordedAt
        ? parsed.recordedAt
        : new Date(0).toISOString(),
    outcome: parsed.outcome,
    skipReason: typeof parsed.skipReason === "string" ? parsed.skipReason : null,
    checks,
    skipScope: skipScope?.length ? normalizeSkipScope(skipScope) : undefined,
    checkSkips: checkSkips.length ? checkSkips : undefined,
  };
}

/** True when readyCi covers this tip as passed or skipped (RAD-97). */
export function isReadyCiSatisfied(
  pr: Pick<LocalPr, "readyCi" | "headSha" | "comments">,
  headSha: string = pr.headSha,
): boolean {
  const record = normalizeReadyCi(pr.readyCi);
  if (!record || record.headSha !== headSha) return false;
  if (record.outcome === "passed") return true;
  if (record.outcome === "skipped") return true;
  return false;
}

/**
 * Tip-scoped skip reason from an agent comment (RAD-97).
 * Only comments stamped with forSha === headSha count — unscoped/legacy skips do not.
 */
export function tipScopedCiSkipReason(
  pr: Pick<LocalPr, "comments">,
  headSha: string,
): string | null {
  for (const comment of pr.comments ?? []) {
    if (comment.replyTo) continue;
    if (comment.forSha !== headSha) continue;
    const reason = parseCiSkipReason(comment.body);
    if (reason) return reason;
  }
  return null;
}

export function readyCiBlockMessage(pr: Pick<LocalPr, "id" | "headSha" | "readyCi">): string {
  const tip = pr.headSha.slice(0, 8);
  const prior = normalizeReadyCi(pr.readyCi);
  const priorNote = prior
    ? ` Last readyCi was ${prior.outcome} for ${prior.headSha.slice(0, 8)}.`
    : "";
  return (
    `Ready blocked (RAD-97): run_ci must be green for HEAD ${tip}, or record an explicit ` +
    `"CI skipped: <reason>" on the loop (set_status ready with ciSkipReason, or a comment).` +
    priorNote
  );
}

export function assertReadyCiSatisfied(
  pr: Pick<LocalPr, "id" | "headSha" | "readyCi" | "comments">,
): void {
  if (!isReadyCiSatisfied(pr)) {
    throw new Error(readyCiBlockMessage(pr));
  }
}

export function readyCiFromRunnerResult(
  headSha: string,
  result: CiRunnerResult,
  recordedAt: string = new Date().toISOString(),
): ReadyCiRecord | null {
  if (!result.allPassed) return null;
  const skipScope = normalizeSkipScope(
    result.selection?.checks ?? result.checks.map((c) => c.name),
  );
  const checkSkips = intentionalCheckSkips(result);
  const selectionSkipped = result.selection?.skipped === true && result.checks.length === 0;
  if (selectionSkipped) {
    const skipReason =
      formatCiSelectionReason(result.selection?.reason) || "skip local CI — empty check plan";
    return {
      headSha,
      recordedAt,
      outcome: "skipped",
      skipReason,
      checks: [],
      skipScope,
      checkSkips: [],
    };
  }
  return {
    headSha,
    recordedAt,
    outcome: "passed",
    skipReason: null,
    checks: result.checks.filter((c) => c.passed && !c.skipped).map((c) => c.name),
    skipScope,
    checkSkips: checkSkips.length ? checkSkips : undefined,
  };
}

export function readyCiFromSkipReason(
  headSha: string,
  reason: string,
  recordedAt: string = new Date().toISOString(),
  skipScope: string[] = [],
  namedChecks: readonly string[] = [],
): ReadyCiRecord {
  const skipReason = parseCiSkipReason(reason)?.trim() || reason.trim();
  if (!skipReason) throw new Error("CI skip reason is empty");
  const named = normalizeSkipScope(namedChecks);
  const inherited = normalizeSkipScope(skipScope);
  // A same-HEAD plan stays the scope. Names replace it only when there is
  // no plan to keep. Named checks are always checkSkips, not a new plan.
  const scope = inherited.length ? inherited : named;
  return {
    headSha,
    recordedAt,
    outcome: "skipped",
    skipReason,
    checks: [],
    skipScope: scope,
    checkSkips: named.map((name) => ({ name, reason: skipReason })),
  };
}

/**
 * Upsert a single "Review requested." root for this SHA (RAD-97).
 * Mutates pr.comments. Pass newCommentId when a fresh root must be created.
 * Returns true when a new comment was added, false when an existing one was reused.
 */
export function upsertReviewRequestedComment(
  pr: LocalPr,
  now: string,
  author: string,
  headSha: string,
  newCommentId: string,
): boolean {
  const roots = (pr.comments ?? []).filter(
    (c) => !c.replyTo && isReviewRequestRoot(c) && (c.forSha === headSha || !c.forSha),
  );
  const sameSha = roots.find((c) => c.forSha === headSha);
  if (sameSha) {
    sameSha.body = "Review requested.";
    sameSha.forSha = headSha;
    return false;
  }
  // Legacy roots without forSha: claim the newest as this SHA instead of duplicating.
  const legacy = roots
    .filter((c) => !c.forSha)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (legacy[0]) {
    legacy[0].body = "Review requested.";
    legacy[0].forSha = headSha;
    return false;
  }
  pr.comments.push({
    id: newCommentId,
    body: "Review requested.",
    createdAt: now,
    author,
    role: "agent",
    status: "resolved",
    forSha: headSha,
  });
  return true;
}

function isReviewRequestRoot(comment: LocalPrComment): boolean {
  return (
    comment.role === "agent" &&
    !comment.replyTo &&
    /^review requested\.?$/i.test(comment.body.trim())
  );
}
