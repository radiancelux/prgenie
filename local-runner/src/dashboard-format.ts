import type { JobRecord } from "./types.js";
import {
  humanizeKebabSlug,
  jobAgentDisplayLabel,
  linearSlugTitleFromTicketUrl,
} from "./job-display.js";
import {
  jobRepoDisplayLabel,
  repoBasenameFromPath,
  repoOwnerNameFromPrUrl,
  repoOwnerNameFromRemoteUrl,
} from "./repo-display.js";

/** Hide failed/stopped clutter with no PR or ticket after this long. */
export const STALE_JOB_HIDE_AFTER_MS = 60 * 60 * 1000;

export function isDocsJobRecord(job: JobRecord): boolean {
  return job.input.jobType === "docs" || job.input.profile === "docs";
}

const DOCS_STAGE_LABELS: Record<string, string> = {
  building: "Writing",
  reviewing: "Review",
  fixing: "Revising",
  approved: "Ready to publish",
  changes_remaining: "Needs edits",
  stuck: "Blocked",
  failed: "Problem",
  stopped: "Stopped",
};

export function dashboardStageLabel(job: JobRecord): string {
  if (!isDocsJobRecord(job)) {
    if (job.stage === "reviewing") return `reviewing (r${job.reviewRound})`;
    return job.stage;
  }
  const base = DOCS_STAGE_LABELS[job.stage] ?? job.stage;
  if (job.stage === "reviewing") return `${base} (r${job.reviewRound})`;
  return base;
}

export function dashboardChecksColumnHeader(job: JobRecord): string {
  return isDocsJobRecord(job) ? "Doc checks" : "Status";
}

export function dashboardChecksStatusLabel(job: JobRecord, ci: JobRecord["ciStatus"]): string {
  if (!ci) return "—";
  if (isDocsJobRecord(job)) {
    if (ci.status === "unknown") return ci.summary || "Doc checks unknown";
    if (ci.status === "success") return ci.summary || "ok";
    if (ci.status === "failure") return ci.summary || "failed";
    return ci.summary || ci.status || "—";
  }
  if (ci.status === "unknown") return "CI unknown";
  if (ci.status === "success") return ci.summary || "green";
  return ci.summary || ci.status || "—";
}

export function shouldHideStaleJob(job: JobRecord, nowMs = Date.now()): boolean {
  if (job.stage !== "failed" && job.stage !== "stopped") return false;
  const hasPr = job.prNumber != null || !!job.prUrl;
  const hasTicket = !!job.linearIssue || !!job.ticketUrl;
  if (hasPr || hasTicket) return false;
  const t = Date.parse(job.updatedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t >= STALE_JOB_HIDE_AFTER_MS;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Relative label for the Updated column; full local datetime in title. */
export function formatRelativeTime(
  iso: string,
  nowMs: number,
  locale?: string,
): { label: string; title: string } {
  const loc = locale ?? undefined;
  const t = Date.parse(iso);
  const title = Number.isNaN(t)
    ? iso
    : new Date(t).toLocaleString(loc, {
        dateStyle: "medium",
        timeStyle: "short",
      });
  if (Number.isNaN(t)) return { label: iso, title };

  const diff = nowMs - t;
  if (diff < 45_000) return { label: "just now", title };
  if (diff < MINUTE_MS) return { label: `${Math.max(1, Math.round(diff / 1000))}s ago`, title };
  if (diff < HOUR_MS) {
    const m = Math.round(diff / MINUTE_MS);
    return { label: `${m}m ago`, title };
  }
  if (diff < DAY_MS) {
    const h = Math.round(diff / HOUR_MS);
    return { label: `${h}h ago`, title };
  }
  const label = new Date(t).toLocaleDateString(loc, { month: "short", day: "numeric" });
  return { label, title };
}

export function dashboardFormatBrowserScript(): string {
  return `(function() {
const STALE_JOB_HIDE_AFTER_MS = ${STALE_JOB_HIDE_AFTER_MS};
const MINUTE_MS = ${MINUTE_MS};
const HOUR_MS = ${HOUR_MS};
const DAY_MS = ${DAY_MS};
const DOCS_STAGE_LABELS = ${JSON.stringify(DOCS_STAGE_LABELS)};
${isDocsJobRecord.toString()}
${dashboardStageLabel.toString()}
${dashboardChecksColumnHeader.toString()}
${dashboardChecksStatusLabel.toString()}
${shouldHideStaleJob.toString()}
${formatRelativeTime.toString()}
${repoOwnerNameFromRemoteUrl.toString()}
${repoOwnerNameFromPrUrl.toString()}
${repoBasenameFromPath.toString()}
${jobRepoDisplayLabel.toString()}
${humanizeKebabSlug.toString()}
${linearSlugTitleFromTicketUrl.toString()}
${jobAgentDisplayLabel.toString()}
return { isDocsJobRecord, dashboardStageLabel, dashboardChecksColumnHeader, dashboardChecksStatusLabel, shouldHideStaleJob, formatRelativeTime, jobRepoDisplayLabel, jobAgentDisplayLabel };
})()`;
}
