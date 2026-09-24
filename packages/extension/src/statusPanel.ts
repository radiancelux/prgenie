/**
 * RAD-110: Local PRs STATUS panel (formerly EXPORT) — idle clear + per-phase copy.
 * Strings are injected into the webview; keep this the single source of truth.
 */

export const STATUS_PANEL_TITLE = "STATUS";

export type StatusPanelPhase =
  | "idle"
  | "draft"
  | "ready"
  | "review_interrupted"
  | "changes_requested"
  | "reviewed_pending"
  | "reviewed_hint"
  | "archived";

export type StatusPanelGuidance = {
  badge: string;
  body: string;
};

/** Idle / empty STATUS body — never a leftover READY/FAIL gate list. */
export function statusPanelIdleBody(options: {
  archivedCount?: number;
  searchQuery?: string;
}): string {
  const archived = options.archivedCount ?? 0;
  if (options.searchQuery?.trim()) {
    return "No matching loops. Clear search to see status for a live loop.";
  }
  if (archived > 0) {
    return "No active loops. Show archived to browse exported loops — STATUS stays idle until a live loop is selected.";
  }
  return "No loops yet. STATUS shows draft, review, CI, and export progress for the selected loop.";
}

/** Phase-correct STATUS copy for a selected loop (no misleading export-blocked gate). */
export function statusPanelGuidanceForLoop(
  status: string,
  options: { humanHint?: string; humanKind?: string } = {},
): StatusPanelGuidance {
  switch (status) {
    case "draft":
      return {
        badge: "DRAFT",
        body: "Not ready for review. Implement in the worktree, then Mark ready when you want a review.",
      };
    case "ready":
      return {
        badge: "READY",
        body: "Ready for review. Waiting on the reviewer — STATUS is not an export gate yet.",
      };
    case "review_interrupted":
      return {
        badge: "REVIEW INTERRUPTED",
        body: "Reviewer Task interrupted (auth/host). Resume the same Task — prgenie review-resume / MCP resume_review — no re-brief.",
      };
    case "changes_requested":
      return {
        badge: "CHANGES REQUESTED",
        body: "Address open findings in the worktree, then Mark ready again for another review pass.",
      };
    case "reviewed": {
      if (options.humanKind === "pending") {
        return {
          badge: "PENDING",
          body:
            options.humanHint ||
            "Review is done. Shepherd CI must pass before Open on GitHub is available.",
        };
      }
      return {
        badge: "—",
        body:
          options.humanHint ||
          "Review is done. Shepherd CI must pass before Open on GitHub is available.",
      };
    }
    case "approved":
      return {
        badge: "ARCHIVED",
        body: "Archived after export (or Archive locally). Read-only — no live export gate.",
      };
    default:
      return {
        badge: status.replace("_", " ").toUpperCase() || "—",
        body: "Select a live loop to see draft, review, CI, or export status.",
      };
  }
}

/** Disabled Open on GitHub helper while export/gate is busy (RAD-124). */
export function exportBusyHelper(step: string | undefined): string {
  const label = (step && step.trim()) || "export in progress";
  return `Open on GitHub unavailable — ${label}`;
}
