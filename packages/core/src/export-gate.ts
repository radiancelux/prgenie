import { looksLikeStaleFullSuitePlan } from "./ci-select-worktree.js";
import type { ShepherdResult } from "./shepherd.js";
import type {
  ExportGateCiCheck,
  ExportGateCiPlan,
  ExportGateOverride,
  ExportGateReason,
  ExportGateSnapshot,
  LocalPr,
} from "./types.js";

export function normalizeExportGateOverride(raw: unknown): ExportGateOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ExportGateOverride>;
  if (typeof row.who !== "string" || !row.who.trim()) return null;
  if (typeof row.why !== "string" || !row.why.trim()) return null;
  if (typeof row.headSha !== "string" || !row.headSha.trim()) return null;
  return {
    who: row.who.trim(),
    why: row.why.trim(),
    headSha: row.headSha.trim(),
    recordedAt:
      typeof row.recordedAt === "string" && row.recordedAt
        ? row.recordedAt
        : new Date(0).toISOString(),
  };
}

const CI_CHECK_NAME_RE = /CI check failed:\s+([^\s—]+)/;

/** Named check from a CI block message. Bare `ci` is not a skipped-check name. */
function ciCheckNameFromBlockMessage(message: string): string | null {
  const name = message.match(CI_CHECK_NAME_RE)?.[1];
  if (!name || name === "ci") return null;
  return name;
}

const SKIPPED_CHECKS_LINE = /Skipped checks:\s*([^\n]+)/gi;

/** Names listed on a `Skipped checks:` line (backticks optional). */
function skippedCheckSectionNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(SKIPPED_CHECKS_LINE)) {
    for (const part of match[1].split(",")) {
      const name = part.replace(/`/g, "").trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Body documents one blocked CI reason when it quotes the blocked message,
 * wraps the check name in backticks, or lists it under `Skipped checks:`.
 * A bare substring (`lint`, `test`) is not enough (RAD-144).
 */
function bodyDocumentsBlockedCi(body: string, reason: ExportGateReason): boolean {
  const message = reason.message.trim();
  if (!message) return false;
  if (body.includes(message)) return true;
  const name = ciCheckNameFromBlockMessage(message);
  if (!name) return false;
  if (body.includes("`" + name + "`")) return true;
  return skippedCheckSectionNames(body).has(name);
}

/**
 * Override must be on the packet, bound to this HEAD, and the body must name
 * who, why, and each skipped CI check (or that check's blocked message).
 */
export function exportGateOverrideDocumented(
  pr: Pick<LocalPr, "body" | "exportGateOverride" | "headSha">,
  blocked: Pick<ShepherdResult, "reasons">,
): boolean {
  const override = normalizeExportGateOverride(pr.exportGateOverride);
  if (!override) return false;
  if (override.headSha !== pr.headSha) return false;
  const body = pr.body ?? "";
  if (!body.includes(override.who) || !body.includes(override.why)) return false;
  const ciReasons = (blocked.reasons ?? []).filter((r) => r.check === "ci");
  if (ciReasons.length === 0) return false;
  return ciReasons.every((reason) => bodyDocumentsBlockedCi(body, reason));
}

/** Override bypasses CI blocks only — not review, preflight, or GitHub (RAD-144). */
export function exportGateOverrideAllowsBlockedExport(
  pr: Pick<LocalPr, "body" | "exportGateOverride" | "headSha">,
  shepherd: Pick<ShepherdResult, "reasons">,
): boolean {
  if (!exportGateOverrideDocumented(pr, shepherd)) return false;
  const reasons = shepherd.reasons ?? [];
  if (reasons.length === 0) return false;
  return reasons.every((r) => r.check === "ci");
}

export type HumanExportKind = "exportable" | "blocked" | "pending" | "other";

export type HumanExportState =
  | { kind: "exportable" }
  | { kind: "blocked"; reasons: ExportGateReason[] }
  | { kind: "pending" }
  | { kind: "other" };

export interface HumanExportUi {
  kind: HumanExportKind;
  yourTurn: boolean;
  showExportPrimary: boolean;
  listStatus: string;
  pillText: string;
  hint: string;
  blockedLabel: string | null;
}

/**
 * RAD-72 label pair (keep these in lockstep in UI + CLI):
 * - status / pill / helper: Push to origin
 * - primary action (detail CTA, confirm, first-enter popup): Open on GitHub
 */
export const HUMAN_EXPORT_STATUS_LABEL = "push to origin";
export const HUMAN_EXPORT_PRIMARY_ACTION = "Open on GitHub";
export const HUMAN_EXPORT_DISMISS_ACTION = "Dismiss";
export const HUMAN_EXPORT_HINT =
  "Review is done — push to origin. Open on GitHub pushes the branch and creates the pull request. Archive locally keeps it local only.";
export const HUMAN_EXPORT_COMPOSER_HINT =
  "Open findings go to the implementor. Address nests a reply underneath. When status is push to origin, Open on GitHub creates the PR.";

export function humanExportEnterMessage(title: string): string {
  return `"${title}" is ready — push to origin`;
}

export function humanExportConfirmMessage(title: string): string {
  return `Push "${title}" to origin? This pushes the loop branch and creates a GitHub pull request.`;
}

export function exportReadyEnterKey(pr: Pick<LocalPr, "id" | "headSha">): string {
  return `${pr.id}@${pr.headSha}`;
}

export function nextExportReadyEnter(
  prs: Array<{
    id: string;
    title: string;
    headSha: string;
    humanExport?: Pick<HumanExportUi, "kind">;
  }>,
  notified: Iterable<string>,
): { id: string; title: string; key: string } | null {
  const seen = new Set(notified);
  for (const pr of prs) {
    if (pr.humanExport?.kind !== "exportable") continue;
    const key = exportReadyEnterKey(pr);
    if (!seen.has(key)) return { id: pr.id, title: pr.title, key };
  }
  return null;
}

export function retainExportReadyNotified(
  prs: Array<{ id: string; headSha: string; humanExport?: Pick<HumanExportUi, "kind"> }>,
  notified: Iterable<string>,
): string[] {
  const live = new Set(
    prs.filter((pr) => pr.humanExport?.kind === "exportable").map(exportReadyEnterKey),
  );
  return [...new Set(notified)].filter((key) => live.has(key));
}

const GATE_CHECKS = new Set<ExportGateReason["check"]>(["review", "preflight", "github", "ci"]);

export function pendingExportGate(headSha: string): ExportGateSnapshot {
  return {
    status: "pending",
    reasons: [],
    headSha,
    evaluatedAt: null,
  };
}

export function normalizeExportGate(raw: unknown): ExportGateSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Partial<ExportGateSnapshot>;
  if (g.status !== "ready" && g.status !== "blocked" && g.status !== "pending") return null;
  if (typeof g.headSha !== "string" || !g.headSha) return null;
  const reasons: ExportGateReason[] = [];
  if (Array.isArray(g.reasons)) {
    for (const item of g.reasons) {
      if (!item || typeof item !== "object") continue;
      const check = (item as ExportGateReason).check;
      const message = (item as ExportGateReason).message;
      if (!GATE_CHECKS.has(check) || typeof message !== "string") continue;
      reasons.push({ check, message });
    }
  }
  const ciPlan = normalizeCiPlan(g.ciPlan);
  const ciChecks = normalizeCiChecks(g.ciChecks);
  const envRaw = g.ciEnvUnhealthy;
  let ciEnvUnhealthy: ExportGateSnapshot["ciEnvUnhealthy"] = null;
  if (
    envRaw &&
    typeof envRaw === "object" &&
    typeof envRaw.message === "string" &&
    envRaw.message
  ) {
    const fixSteps = Array.isArray(envRaw.fixSteps)
      ? envRaw.fixSteps.filter((s): s is string => typeof s === "string")
      : [];
    ciEnvUnhealthy = { message: envRaw.message, fixSteps };
  }
  return {
    status: g.status,
    reasons,
    headSha: g.headSha,
    evaluatedAt: typeof g.evaluatedAt === "string" ? g.evaluatedAt : null,
    ciPlan,
    ciChecks,
    ciCwd: typeof g.ciCwd === "string" && g.ciCwd ? g.ciCwd : null,
    ciEnvUnhealthy,
  };
}

function normalizeCiPlanReason(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    const reasons = raw.filter((r): r is string => typeof r === "string" && r.length > 0);
    return reasons.length ? reasons : null;
  }
  if (typeof raw === "string" && raw.length > 0) return [raw];
  return null;
}

function normalizeCiPlan(raw: unknown): ExportGateCiPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const plan = raw as Partial<ExportGateCiPlan> & { reason?: unknown };
  if (!Array.isArray(plan.checks)) return null;
  const reason = normalizeCiPlanReason(plan.reason);
  if (!reason) return null;
  const checks = plan.checks.filter((c): c is string => typeof c === "string" && c.length > 0);
  if (checks.length === 0) return null;
  return { checks, reason, uncertain: plan.uncertain === true };
}

function normalizeCiChecks(raw: unknown): ExportGateCiCheck[] | null {
  if (!Array.isArray(raw)) return null;
  const checks: ExportGateCiCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<ExportGateCiCheck>;
    if (typeof row.name !== "string" || !row.name) continue;
    checks.push({
      name: row.name,
      passed: row.passed === true,
      skipped: row.skipped === true ? true : undefined,
      excerpt: typeof row.excerpt === "string" ? row.excerpt : undefined,
      logPath: typeof row.logPath === "string" ? row.logPath : undefined,
      elapsedMs: typeof row.elapsedMs === "number" ? row.elapsedMs : undefined,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    });
  }
  return checks.length ? checks : null;
}

/** Snapshot is usable only when it was evaluated for this loop HEAD. */
export function exportGateForHead(
  pr: Pick<LocalPr, "headSha" | "exportGate">,
): ExportGateSnapshot | null {
  const gate = normalizeExportGate(pr.exportGate);
  if (!gate || gate.headSha !== pr.headSha) return null;
  return gate;
}

/**
 * True when a stored export-gate CI plan is the pre-RAD-119 / stale-plugin root
 * suite (root `test`/`build` or classic reason). Peer replay must not reuse it (RAD-123).
 */
export function exportGateHasStaleFullSuiteCiPlan(
  gate: ExportGateSnapshot | null | undefined,
): boolean {
  if (!gate?.ciPlan) return false;
  return looksLikeStaleFullSuitePlan({
    checks: gate.ciPlan.checks,
    reason: gate.ciPlan.reason,
  });
}

/**
 * Complete ready/blocked snapshot for this HEAD that is safe to adopt (not a
 * stale full-suite dogfood plan).
 */
export function exportGateSnapshotIsAdoptable(
  snap: ExportGateSnapshot | null | undefined,
  headSha: string,
): boolean {
  return Boolean(
    snap &&
    snap.headSha === headSha &&
    snap.evaluatedAt &&
    (snap.status === "ready" || snap.status === "blocked") &&
    !exportGateHasStaleFullSuiteCiPlan(snap),
  );
}

export function needsExportGateEvaluation(pr: {
  status: string;
  headSha: string;
  exportGate?: ExportGateSnapshot | null;
}): boolean {
  if (pr.status !== "reviewed") return false;
  const gate = exportGateForHead(pr);
  if (!gate || gate.status === "pending") return true;
  // Stale full-suite snapshot must be re-run with worktree selectCiChecks (RAD-123).
  if (exportGateHasStaleFullSuiteCiPlan(gate)) return true;
  return false;
}

export function humanExportState(
  pr: Pick<LocalPr, "status" | "headSha" | "exportGate">,
): HumanExportState {
  if (pr.status !== "reviewed") return { kind: "other" };
  const gate = exportGateForHead(pr);
  if (!gate || gate.status === "pending") return { kind: "pending" };
  if (gate.status === "blocked") return { kind: "blocked", reasons: gate.reasons };
  return { kind: "exportable" };
}

export function isHumanExportable(pr: Pick<LocalPr, "status" | "headSha" | "exportGate">): boolean {
  return humanExportState(pr).kind === "exportable";
}

/** Prefer CI check names (format/lint/typecheck/test/build); else first gate. */
export function formatExportBlockLabel(
  reasons: ExportGateReason[],
  gate?: ExportGateSnapshot | null,
): string {
  // RAD-126: stale/refused plans must not label failingCheck as root `test`.
  if (exportGateHasStaleFullSuiteCiPlan(gate) || reasonsLookLikeSelectionRefusal(reasons)) {
    return "ci-select";
  }
  const ciNames = reasons
    .filter((r) => r.check === "ci")
    .map((r) => ciCheckNameFromBlockMessage(r.message) ?? "ci");
  if (ciNames.length) return ciNames.join(", ");
  const first = reasons[0];
  if (!first) return "export";
  return first.check;
}

/** Messages from refuse-stale / worktree-select paths (RAD-123 / RAD-119 / RAD-126). */
export function reasonsLookLikeSelectionRefusal(reasons: ExportGateReason[]): boolean {
  return reasons.some((r) =>
    /refusing stale|stale full-suite|worktree select|selectCiChecks|selection.?refus|never root pnpm test/i.test(
      r.message,
    ),
  );
}

export function humanExportUi(pr: LocalPr): HumanExportUi {
  if (pr.status === "approved") {
    return {
      kind: "other",
      yourTurn: false,
      showExportPrimary: false,
      listStatus: "archived",
      pillText: "approved",
      hint: "Archived after opening on GitHub (or Archive locally). Reopen to continue, or Delete to remove the record.",
      blockedLabel: null,
    };
  }
  if (pr.status !== "reviewed") {
    const label = pr.status.replace("_", " ");
    return {
      kind: "other",
      yourTurn: false,
      showExportPrimary: false,
      listStatus: label,
      pillText: label,
      hint: "",
      blockedLabel: null,
    };
  }
  const state = humanExportState(pr);
  if (state.kind === "exportable") {
    return {
      kind: "exportable",
      yourTurn: true,
      showExportPrimary: true,
      listStatus: HUMAN_EXPORT_STATUS_LABEL,
      pillText: HUMAN_EXPORT_STATUS_LABEL,
      hint: HUMAN_EXPORT_HINT,
      blockedLabel: null,
    };
  }
  if (state.kind === "blocked") {
    const blockedLabel = formatExportBlockLabel(state.reasons, pr.exportGate);
    return {
      kind: "blocked",
      yourTurn: false,
      showExportPrimary: false,
      listStatus: `blocked — ${blockedLabel}`,
      pillText: "blocked",
      hint: `Export blocked — ${blockedLabel}. Fix the failing check before opening on GitHub.`,
      blockedLabel,
    };
  }
  return {
    kind: "pending",
    yourTurn: false,
    showExportPrimary: false,
    listStatus: "reviewed",
    pillText: "reviewed",
    hint: "Review is done. Shepherd CI must pass before Open on GitHub is available.",
    blockedLabel: null,
  };
}

/**
 * For reviewed loops, never paint shepherd "ready" until the stored full gate
 * is green. Cheap sidebar results omit CI.
 */
export function displayShepherdStatus(
  cheap: ShepherdResult | null,
  pr: Pick<LocalPr, "status" | "headSha" | "exportGate">,
): ShepherdResult | null {
  const gate = exportGateForHead(pr);
  if (gate && (gate.status === "ready" || gate.status === "blocked")) {
    return { status: gate.status, reasons: gate.reasons };
  }
  if (pr.status === "reviewed") {
    const reasons = [...(cheap?.reasons ?? [])];
    if (!reasons.some((r) => r.check === "ci")) {
      reasons.push({ check: "ci", message: "CI not evaluated yet for this HEAD" });
    }
    return { status: "blocked", reasons };
  }
  return cheap;
}
