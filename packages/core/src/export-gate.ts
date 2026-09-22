import type { ShepherdResult } from "./shepherd.js";
import type {
  ExportGateCiCheck,
  ExportGateCiPlan,
  ExportGateReason,
  ExportGateSnapshot,
  LocalPr,
} from "./types.js";

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
  return {
    status: g.status,
    reasons,
    headSha: g.headSha,
    evaluatedAt: typeof g.evaluatedAt === "string" ? g.evaluatedAt : null,
    ciPlan,
    ciChecks,
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

export function needsExportGateEvaluation(pr: {
  status: string;
  headSha: string;
  exportGate?: ExportGateSnapshot | null;
}): boolean {
  if (pr.status !== "reviewed") return false;
  const gate = exportGateForHead(pr);
  return !gate || gate.status === "pending";
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
export function formatExportBlockLabel(reasons: ExportGateReason[]): string {
  const ciNames = reasons
    .filter((r) => r.check === "ci")
    .map((r) => {
      const match = r.message.match(/CI check failed:\s+([^\s—]+)/);
      return match?.[1] ?? "ci";
    });
  if (ciNames.length) return ciNames.join(", ");
  const first = reasons[0];
  if (!first) return "export";
  return first.check;
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
    const blockedLabel = formatExportBlockLabel(state.reasons);
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
