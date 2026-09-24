import { getLocalPr, isArchivedPr, listLocalPrs } from "./prs.js";
import { getStewardBinding, listStewardBindings, type StewardBinding } from "./steward.js";
import type { LocalPr } from "./types.js";

export interface SessionReconcileRow {
  loopId: string;
  title: string;
  status: LocalPr["status"];
  headRef: string;
  headSha: string;
  implementorTaskId: string | null;
  reviewerTaskId: string | null;
  /** Short action hint for the steward (resume / spawn / wait). */
  hint: string;
}

/**
 * Reconcile live loop status vs steward Task ids (RAD-97 / RAD-88 stuck-Task slice).
 * One digest for session reconnect — not a full token-budget redesign.
 */
export async function reconcileSessionLoops(cwd: string): Promise<SessionReconcileRow[]> {
  const live = (await listLocalPrs(cwd)).filter((pr) => !isArchivedPr(pr));
  const bindings = await listStewardBindings(cwd);
  const byId = new Map(bindings.map((b) => [b.loopId, b]));
  const rows: SessionReconcileRow[] = [];
  for (const pr of live) {
    const binding = byId.get(pr.id) ?? null;
    rows.push(rowForLoop(pr, binding));
  }
  return rows;
}

export function rowForLoop(pr: LocalPr, binding: StewardBinding | null): SessionReconcileRow {
  const implementorTaskId = binding?.implementorTaskId ?? null;
  const reviewerTaskId = binding?.reviewerTaskId ?? null;
  return {
    loopId: pr.id,
    title: pr.title,
    status: pr.status,
    headRef: pr.headRef,
    headSha: pr.headSha,
    implementorTaskId,
    reviewerTaskId,
    hint: hintFor(pr.status, implementorTaskId, reviewerTaskId),
  };
}

function hintFor(
  status: LocalPr["status"],
  implementorTaskId: string | null,
  reviewerTaskId: string | null,
): string {
  switch (status) {
    case "review_interrupted":
      return reviewerTaskId
        ? `Resume reviewer Task ${reviewerTaskId} (prgenie review-resume ${"{id}"} / MCP resume_review) — no re-brief.`
        : "review_interrupted with no reviewerTaskId — spawn_reviewer via steward_next.";
    case "ready":
      return reviewerTaskId
        ? `Resume reviewer Task ${reviewerTaskId} (or await complete_review).`
        : "Spawn reviewer Task and bind reviewerTaskId.";
    case "changes_requested":
      return implementorTaskId
        ? `Resume implementor Task ${implementorTaskId} (do not spawn a twin).`
        : "Spawn implementor Task and bind implementorTaskId.";
    case "draft":
      return implementorTaskId
        ? `Resume implementor Task ${implementorTaskId}.`
        : "Spawn implementor Task and bind implementorTaskId.";
    case "reviewed":
      return "Run steward_next / export gate — do not spawn a reviewer.";
    case "approved":
      return "Archived — no action.";
    default:
      return "Check steward_next.";
  }
}

/** Human-readable digest for sessionStart / CLI. */
export function formatSessionReconcileDigest(rows: SessionReconcileRow[]): string {
  if (rows.length === 0) {
    return "PR Genie session reconcile: no live loops.";
  }
  const lines = ["PR Genie session reconcile (Task ids vs loop status):", ""];
  for (const row of rows) {
    lines.push(
      `${row.loopId}  ${row.status}  ${row.headRef}  ${row.headSha.slice(0, 8)}  "${row.title}"`,
    );
    lines.push(
      `  implementor=${row.implementorTaskId ?? "-"}  reviewer=${row.reviewerTaskId ?? "-"}`,
    );
    lines.push(`  → ${row.hint.replace("{id}", row.loopId)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function formatSessionReconnectDigest(cwd: string): Promise<string | null> {
  const rows = await reconcileSessionLoops(cwd);
  if (rows.length === 0) return null;
  return formatSessionReconcileDigest(rows);
}

/** Convenience for a single loop (MCP / CLI). */
export async function reconcileOneLoop(cwd: string, id: string): Promise<SessionReconcileRow> {
  const pr = await getLocalPr(cwd, id);
  const binding = await getStewardBinding(cwd, pr.id);
  return rowForLoop(pr, binding);
}
