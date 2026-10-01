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
    return "No active loops. Expand Archive below to browse exported loops — STATUS stays idle until a live loop is selected. Clear archived permanently deletes local packets, worktrees, and local loop branches; remotes stay.";
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

export type StatusPanelPaintInput = {
  liveCount: number;
  archivedCount?: number;
  searchQuery?: string;
  selected: {
    id: string;
    status: string;
    humanHint?: string;
    humanKind?: string;
  } | null;
  progress: {
    id: string;
    step?: string;
    state?: string;
    cancelled?: boolean;
    failed?: boolean;
  } | null;
  shepherd: { status: string; reasons?: { check: string; message: string }[] } | null;
  exportingId?: string | null;
};

export type StatusPanelPaintDecision = {
  title: string;
  mode: "quiet" | "gate";
  badge: string;
  body: string;
  statusClass: string;
  showReasons: boolean;
  showProgress: boolean;
  showCiCard: boolean;
  progressStep?: string;
};

/** Injectable STATUS paint logic (plain JS — no module closures). */
const DECIDE_STATUS_PANEL_PAINT_BODY = `
  function quiet(badge, body) {
    return {
      title: "STATUS",
      mode: "quiet",
      badge: badge,
      body: body,
      statusClass: "quiet",
      showReasons: false,
      showProgress: false,
      showCiCard: false,
    };
  }
  var liveCount = input.liveCount != null ? input.liveCount : 0;
  var archivedCount = input.archivedCount != null ? input.archivedCount : 0;
  var searchQuery = input.searchQuery != null ? input.searchQuery : "";
  var selected = input.selected;
  var progress = input.progress;
  var shepherd = input.shepherd;
  var exportingId = input.exportingId != null ? input.exportingId : null;
  if (liveCount === 0 && !selected) {
    var idleBody;
    if (searchQuery.trim()) {
      idleBody = "No matching loops. Clear search to see status for a live loop.";
    } else if (archivedCount > 0) {
      idleBody = "No active loops. Expand Archive below to browse exported loops — STATUS stays idle until a live loop is selected. Clear archived permanently deletes local packets, worktrees, and local loop branches; remotes stay.";
    } else {
      idleBody = "No loops yet. STATUS shows draft, review, CI, and export progress for the selected loop.";
    }
    return quiet("IDLE", idleBody);
  }
  if (liveCount > 0 && !selected) {
    return quiet("—", "Select a live loop to see draft, review, CI, or export status.");
  }
  if (!selected) {
    return quiet("IDLE", "No loops yet. STATUS shows draft, review, CI, and export progress for the selected loop.");
  }
  var preReviewed = ["draft", "ready", "review_interrupted", "changes_requested", "approved"];
  if (preReviewed.indexOf(selected.status) >= 0) {
    var badge;
    var phaseBody;
    switch (selected.status) {
      case "draft":
        badge = "DRAFT";
        phaseBody = "Not ready for review. Implement in the worktree, then Mark ready when you want a review.";
        break;
      case "ready":
        badge = "READY";
        phaseBody = "Ready for review. Waiting on the reviewer — STATUS is not an export gate yet.";
        break;
      case "review_interrupted":
        badge = "REVIEW INTERRUPTED";
        phaseBody = "Reviewer Task interrupted (auth/host). Resume the same Task — prgenie review-resume / MCP resume_review — no re-brief.";
        break;
      case "changes_requested":
        badge = "CHANGES REQUESTED";
        phaseBody = "Address open findings in the worktree, then Mark ready again for another review pass.";
        break;
      case "approved":
        badge = "ARCHIVED";
        phaseBody = "Archived after export (or Archive locally). Read-only — no live export gate.";
        break;
      default:
        badge = selected.status.replace("_", " ").toUpperCase() || "—";
        phaseBody = "Select a live loop to see draft, review, CI, or export status.";
    }
    return quiet(badge, phaseBody);
  }
  if (selected.status === "reviewed") {
    var matchingProgress = progress && progress.id === selected.id ? progress : null;
    var exportBusyOnSelected = exportingId === selected.id;
    if (matchingProgress || exportBusyOnSelected) {
      var gateBadge = "running";
      var statusClass = "running";
      if (matchingProgress && matchingProgress.cancelled) {
        gateBadge = "cancelled";
        statusClass = "blocked";
      } else if (
        matchingProgress &&
        (matchingProgress.state === "start" ||
          matchingProgress.state === "cached" ||
          matchingProgress.state === "pass")
      ) {
        gateBadge = "running";
        statusClass = "running";
      } else if (shepherd) {
        gateBadge = shepherd.status;
        statusClass = shepherd.status;
      }
      var activeProgress =
        matchingProgress && !matchingProgress.cancelled && !matchingProgress.failed;
      var showReasons = !!(
        shepherd &&
        shepherd.reasons &&
        shepherd.reasons.length &&
        (!activeProgress || (matchingProgress && (matchingProgress.cancelled || matchingProgress.failed)))
      );
      return {
        title: "STATUS",
        mode: "gate",
        badge: gateBadge,
        body: "",
        statusClass: statusClass,
        showReasons: showReasons,
        showProgress: true,
        showCiCard: true,
        progressStep: matchingProgress ? matchingProgress.step : undefined,
      };
    }
    if (shepherd && shepherd.status === "blocked") {
      return {
        title: "STATUS",
        mode: "gate",
        badge: "blocked",
        body: "",
        statusClass: "blocked",
        showReasons: true,
        showProgress: false,
        showCiCard: true,
      };
    }
    if (shepherd) {
      return {
        title: "STATUS",
        mode: "gate",
        badge: shepherd.status,
        body: "",
        statusClass: shepherd.status,
        showReasons: !!(shepherd.reasons && shepherd.reasons.length > 0),
        showProgress: false,
        showCiCard: true,
      };
    }
    var hint =
      selected.humanHint ||
      "Review is done. Shepherd CI must pass before Open on GitHub is available.";
    var pendingBadge = selected.humanKind === "pending" ? "PENDING" : "—";
    return quiet(pendingBadge, hint);
  }
  var fallbackBadge = selected.status.replace("_", " ").toUpperCase() || "—";
  return quiet(fallbackBadge, "Select a live loop to see draft, review, CI, or export status.");
`;

/**
 * Single paint decision for STATUS (RAD-110). Self-contained for webview injection via .toString().
 */
export const decideStatusPanelPaint = new Function("input", DECIDE_STATUS_PANEL_PAINT_BODY) as (
  input: StatusPanelPaintInput,
) => StatusPanelPaintDecision;
