import type { JobRecord } from "./types.js";

/** Hide failed/stopped clutter with no PR or ticket after this long. */
export const STALE_JOB_HIDE_AFTER_MS = 60 * 60 * 1000;

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
${shouldHideStaleJob.toString()}
${formatRelativeTime.toString()}
return { shouldHideStaleJob, formatRelativeTime };
})()`;
}
