import type { CiRollupStatus, CiStatusInfo, JobRecord } from "./types.js";
import { gh, type GhResult } from "./github.js";
import { spawnCommand } from "./spawn-cmd.js";

/** Default job list hides merged PRs after this long (still kept on disk). */
export const MERGED_HIDE_AFTER_MS = 60 * 60 * 1000;

export type CheckRow = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
};

export function isCiFinal(status: CiRollupStatus): boolean {
  return status === "success" || status === "failure" || status === "neutral";
}

export function isMergedStatus(job: JobRecord): boolean {
  return job.ciStatus?.status === "merged" || !!job.ciStatus?.mergedAt;
}

export function shouldHideMergedJob(job: JobRecord, nowMs = Date.now()): boolean {
  if (!isMergedStatus(job)) return false;
  const mergedAt = job.ciStatus?.mergedAt;
  if (!mergedAt) return false;
  const t = Date.parse(mergedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t >= MERGED_HIDE_AFTER_MS;
}

export type GhPrViewFields = {
  state?: string;
  mergedAt?: string | null;
  mergeable?: string;
  mergeableState?: string;
  url?: string;
};

export function resolveDisplayStatus(
  pr: GhPrViewFields,
  ciRollup: CiRollupStatus,
): { status: CiRollupStatus; mergedAt?: string | null } {
  const state = (pr.state ?? "").toUpperCase();
  if (state === "MERGED" || pr.mergedAt) {
    return { status: "merged", mergedAt: pr.mergedAt ?? null };
  }
  const mergeable = (pr.mergeable ?? "").toUpperCase();
  const mergeableState = (pr.mergeableState ?? "").toUpperCase();
  if (mergeable === "CONFLICTING" || mergeableState === "DIRTY" || mergeableState === "BLOCKED") {
    return { status: "merge_conflict" };
  }
  return { status: ciRollup };
}

/** Roll up individual check rows into one dashboard status. */
export function rollupCheckStatuses(checks: CheckRow[]): {
  status: CiRollupStatus;
  summary: string;
} {
  if (checks.length === 0) {
    return { status: "unknown", summary: "no checks" };
  }

  const names: string[] = [];
  let anyPending = false;
  let anyFailure = false;
  let anySuccess = false;
  let anyNeutral = false;

  for (const c of checks) {
    const name = c.name?.trim() || "check";
    names.push(name);
    const status = (c.status ?? "").toUpperCase();
    const conclusion = (c.conclusion ?? "").toUpperCase();

    const pending =
      status === "IN_PROGRESS" ||
      status === "QUEUED" ||
      status === "PENDING" ||
      status === "WAITING" ||
      conclusion === "PENDING" ||
      (status !== "COMPLETED" && status !== "SUCCESS" && status !== "FAILURE" && !conclusion);

    if (pending && status !== "COMPLETED") {
      anyPending = true;
      continue;
    }

    if (conclusion === "FAILURE" || conclusion === "FAILED" || conclusion === "ERROR") {
      anyFailure = true;
    } else if (conclusion === "SUCCESS" || conclusion === "PASSED" || status === "SUCCESS") {
      anySuccess = true;
    } else if (
      conclusion === "NEUTRAL" ||
      conclusion === "SKIPPED" ||
      conclusion === "CANCELLED" ||
      conclusion === "STALE"
    ) {
      anyNeutral = true;
    } else if (status === "COMPLETED" && !conclusion) {
      anyNeutral = true;
    } else if (pending) {
      anyPending = true;
    } else {
      anyNeutral = true;
    }
  }

  const summary = names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : "");

  if (anyPending) return { status: "pending", summary };
  if (anyFailure) return { status: "failure", summary };
  if (anySuccess && !anyFailure) return { status: "success", summary };
  if (anyNeutral) return { status: "neutral", summary };
  return { status: "unknown", summary };
}

export function rollupFromGithubStatusCheckRollup(
  rollup: Array<{ name?: string; status?: string; conclusion?: string | null }>,
): { status: CiRollupStatus; summary: string } {
  return rollupCheckStatuses(
    rollup.map((r) => ({
      name: r.name,
      status: r.status ?? undefined,
      conclusion: r.conclusion ?? undefined,
    })),
  );
}

async function originCmd(cwd: string, args: string[]): Promise<GhResult> {
  return spawnCommand("origin", cwd, args);
}

function parseOriginChecksJson(stdout: string): CheckRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is CheckRow => x != null && typeof x === "object");
    }
  } catch {
    // fall through — one JSON object per line
  }
  const rows: CheckRow[] = [];
  for (const line of trimmed.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as CheckRow;
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // ignore
    }
  }
  return rows;
}

const GH_PR_VIEW_JSON = "state,mergedAt,mergeable,mergeableState,statusCheckRollup,url";

async function fetchGhPrView(
  cwd: string,
  target: { prNumber?: number | null; branch?: string },
): Promise<
  | {
      ok: true;
      pr: GhPrViewFields;
      ciRollup: CiRollupStatus;
      ciSummary: string;
    }
  | { ok: false }
> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) return { ok: false };

  const ghArgs =
    target.prNumber != null
      ? ["pr", "view", String(target.prNumber), "--json", GH_PR_VIEW_JSON]
      : ["pr", "view", ref, "--json", GH_PR_VIEW_JSON];
  const ghRes = await gh(cwd, ghArgs);
  if (ghRes.code !== 0) return { ok: false };
  try {
    const parsed = JSON.parse(ghRes.stdout) as GhPrViewFields & {
      statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
    };
    const rolled = rollupFromGithubStatusCheckRollup(parsed.statusCheckRollup ?? []);
    return {
      ok: true,
      pr: parsed,
      ciRollup: rolled.status,
      ciSummary: rolled.summary,
    };
  } catch {
    return { ok: false };
  }
}

export async function fetchPrCiStatus(
  cwd: string,
  target: { prNumber?: number | null; branch?: string },
): Promise<Omit<CiStatusInfo, "checkedAt">> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) {
    return { status: "unknown", summary: "no PR", source: "github" };
  }

  const ghView = await fetchGhPrView(cwd, target);
  if (ghView.ok) {
    const fromPr = resolveDisplayStatus(ghView.pr, ghView.ciRollup);
    if (fromPr.status === "merged") {
      return {
        status: "merged",
        summary: "merged",
        checksUrl: ghView.pr.url,
        mergedAt: fromPr.mergedAt ?? ghView.pr.mergedAt ?? null,
        source: "github",
      };
    }
    if (fromPr.status === "merge_conflict") {
      return {
        status: "merge_conflict",
        summary: "merge conflict",
        checksUrl: ghView.pr.url,
        source: "github",
      };
    }
  }

  const originRes = await originCmd(cwd, [
    "pr",
    "checks",
    ref,
    "--json",
    "name,status,conclusion,detailsUrl",
  ]);
  if (originRes.code === 0 && originRes.stdout.trim()) {
    const checks = parseOriginChecksJson(originRes.stdout);
    const rolled = rollupCheckStatuses(checks);
    const checksUrl = checks.find((c) => c.detailsUrl)?.detailsUrl;
    const base = {
      status: rolled.status,
      summary: rolled.summary,
      checksUrl,
      source: "origin" as const,
    };
    if (ghView.ok) {
      const fromPr = resolveDisplayStatus(ghView.pr, rolled.status);
      const summary =
        fromPr.status === "success"
          ? "green"
          : fromPr.status === "merge_conflict"
            ? "merge conflict"
            : rolled.summary;
      return {
        ...base,
        status: fromPr.status,
        summary,
        checksUrl: ghView.pr.url ?? checksUrl,
        mergedAt: fromPr.mergedAt,
      };
    }
    return base;
  }

  if (ghView.ok) {
    const fromPr = resolveDisplayStatus(ghView.pr, ghView.ciRollup);
    const summary =
      fromPr.status === "merged"
        ? "merged"
        : fromPr.status === "merge_conflict"
          ? "merge conflict"
          : fromPr.status === "success"
            ? "green"
            : ghView.ciSummary;
    return {
      status: fromPr.status,
      summary,
      checksUrl: ghView.pr.url,
      mergedAt: fromPr.mergedAt,
      source: "github",
    };
  }

  return {
    status: "unknown",
    summary: "CI lookup failed",
    source: "github",
  };
}

const CI_ACTIVE_STAGES = new Set(["building", "reviewing", "fixing", "approved"]);

const MERGE_WATCH_STAGES = new Set(["approved", "changes_remaining", "stuck", "failed", "stopped"]);

export function shouldPollCi(job: JobRecord): boolean {
  const hasPr = job.prNumber != null || job.prUrl != null;
  if (!hasPr) return false;

  if (isMergedStatus(job)) return false;

  if (MERGE_WATCH_STAGES.has(job.stage)) return true;

  if (job.ciStatus && isCiFinal(job.ciStatus.status)) {
    return false;
  }

  if (CI_ACTIVE_STAGES.has(job.stage)) return true;

  return false;
}
