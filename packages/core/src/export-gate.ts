import type { ShepherdResult } from "./shepherd.js";
import type { ExportGateReason, ExportGateSnapshot, LocalPr } from "./types.js";

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
  return {
    status: g.status,
    reasons,
    headSha: g.headSha,
    evaluatedAt: typeof g.evaluatedAt === "string" ? g.evaluatedAt : null,
  };
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
      listStatus: "your turn — open on GitHub",
      pillText: "your turn",
      hint: "Review is done — your turn. Open on GitHub pushes the branch and creates the pull request. Archive locally keeps it local only.",
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
