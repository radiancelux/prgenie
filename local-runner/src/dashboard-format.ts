import type { CiRollupStatus, DocLintFinding, JobRecord } from "./types.js";
import {
  humanizeKebabSlug,
  jobAgentDisplayLabel,
  jobTicketLinks,
  linearSlugTitleFromTicketUrl,
  ticketLinkLabel,
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

export const DOCS_STAGE_LABELS: Record<string, string> = {
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
  if (job.queueState && job.queueState.queued) return "queued";
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

/** Tailwind badge classes — literal map (no runtime concatenation beyond lookup). */
export const CI_STATUS_BADGE_CLASS: Record<CiRollupStatus, string> = {
  success:
    "inline-flex min-h-11 items-center rounded-full border border-emerald-400/35 bg-emerald-900/25 px-2 py-0.5 text-xs font-medium text-emerald-300",
  failure:
    "inline-flex min-h-11 items-center rounded-full border border-red-400/35 bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-300",
  pending:
    "inline-flex min-h-11 items-center rounded-full border border-amber-400/40 bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-200",
  neutral:
    "inline-flex min-h-11 items-center rounded-full border border-zinc-500/40 bg-zinc-700/35 px-2 py-0.5 text-xs font-medium text-zinc-300",
  unknown:
    "inline-flex min-h-11 items-center rounded-full border border-zinc-500/40 bg-zinc-700/35 px-2 py-0.5 text-xs font-medium text-zinc-300",
  merged:
    "inline-flex min-h-11 items-center rounded-full border border-sky-400/40 bg-sky-900/35 px-2 py-0.5 text-xs font-medium text-sky-200",
  merge_conflict:
    "inline-flex min-h-11 items-center rounded-full border border-orange-400/40 bg-orange-900/30 px-2 py-0.5 text-xs font-medium text-orange-200",
  closed:
    "inline-flex min-h-11 items-center rounded-full border border-violet-400/35 bg-violet-900/30 px-2 py-0.5 text-xs font-medium text-violet-200",
};

export const PR_DRAFT_BADGE_CLASS = {
  draft:
    "inline-flex min-h-11 items-center rounded-full border border-slate-400/35 bg-slate-800/50 px-2 py-0.5 text-xs font-medium text-slate-200",
  ready:
    "inline-flex min-h-11 items-center rounded-full border border-emerald-400/35 bg-emerald-900/25 px-2 py-0.5 text-xs font-medium text-emerald-300",
} as const;

export function dashboardChecksStatusLabel(job: JobRecord, ci: JobRecord["ciStatus"]): string {
  if (!ci) return "—";
  if (isDocsJobRecord(job)) {
    if (ci.status === "unknown") return ci.summary || "Doc checks unknown";
    if (ci.status === "success") return ci.summary || "ok";
    if (ci.status === "failure") return ci.summary || "failed";
    if (ci.status === "neutral") return ci.summary || "warning (non-blocking)";
    return ci.summary || ci.status || "—";
  }
  if (ci.status === "unknown") return "CI unknown";
  if (ci.status === "success") return ci.summary || "green";
  return ci.summary || ci.status || "—";
}

export function ciStatusBadgeClass(status: CiRollupStatus | undefined): string {
  if (!status) return CI_STATUS_BADGE_CLASS.unknown;
  return CI_STATUS_BADGE_CLASS[status] ?? CI_STATUS_BADGE_CLASS.unknown;
}

export function formatDocLintFindingsHtml(
  findings: DocLintFinding[] | undefined,
  truncated?: boolean,
): string {
  if (!findings?.length) return "";
  const rows = findings
    .map((f) => {
      const loc = f.column != null ? `${f.line}:${f.column}` : String(f.line);
      const file = f.file.replace(/</g, "&lt;");
      const rule = f.rule.replace(/</g, "&lt;");
      const msg = f.message.replace(/</g, "&lt;");
      return `<li class="text-sm text-zinc-300"><span class="font-mono text-xs text-sky-300">${file}:${loc}</span> <span class="text-zinc-500">${rule}</span> — ${msg}</li>`;
    })
    .join("");
  const note = truncated
    ? `<p class="mt-1 text-xs text-zinc-500">Additional findings omitted (cap).</p>`
    : "";
  return `<ul class="mt-2 max-h-64 list-disc space-y-1 overflow-y-auto pl-5" role="list">${rows}</ul>${note}`;
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
const CI_STATUS_BADGE_CLASS = ${JSON.stringify(CI_STATUS_BADGE_CLASS)};
const PR_DRAFT_BADGE_CLASS = ${JSON.stringify(PR_DRAFT_BADGE_CLASS)};
${isDocsJobRecord.toString()}
${dashboardStageLabel.toString()}
${dashboardChecksColumnHeader.toString()}
${dashboardChecksStatusLabel.toString()}
${ciStatusBadgeClass.toString()}
${formatDocLintFindingsHtml.toString()}
${shouldHideStaleJob.toString()}
${formatRelativeTime.toString()}
${repoOwnerNameFromRemoteUrl.toString()}
${repoOwnerNameFromPrUrl.toString()}
${repoBasenameFromPath.toString()}
${jobRepoDisplayLabel.toString()}
${humanizeKebabSlug.toString()}
${linearSlugTitleFromTicketUrl.toString()}
${jobAgentDisplayLabel.toString()}
${ticketLinkLabel.toString()}
${jobTicketLinks.toString()}
return { isDocsJobRecord, dashboardStageLabel, dashboardChecksColumnHeader, dashboardChecksStatusLabel, ciStatusBadgeClass, formatDocLintFindingsHtml, shouldHideStaleJob, formatRelativeTime, jobRepoDisplayLabel, jobAgentDisplayLabel, jobTicketLinks, CI_STATUS_BADGE_CLASS, PR_DRAFT_BADGE_CLASS };
})()`;
}
