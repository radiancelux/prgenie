import os from "node:os";
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
  if (state === "CLOSED") {
    return { status: "closed" };
  }
  const mergeable = (pr.mergeable ?? "").toUpperCase();
  if (mergeable === "CONFLICTING") {
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

export function repoSlugFromPrUrl(prUrl: string | null | undefined): string | null {
  if (!prUrl?.trim()) return null;
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//i);
  return m ? m[1] : null;
}

export const GH_PR_VIEW_JSON = "state,mergedAt,mergeable,statusCheckRollup,url";

export function buildGhPrViewArgs(
  repoSlug: string | null | undefined,
  target: { prNumber?: number | null; branch?: string },
): string[] | null {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) return null;

  const args =
    target.prNumber != null
      ? ["pr", "view", String(target.prNumber), "--json", GH_PR_VIEW_JSON]
      : ["pr", "view", ref, "--json", GH_PR_VIEW_JSON];
  const slug = repoSlug?.trim();
  if (slug && slug.includes("/")) {
    args.push("--repo", slug);
  }
  return args;
}

export function firstStderrLine(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 240) : "gh command failed";
}

function ciSummaryLabel(status: CiRollupStatus, rollupSummary: string): string {
  switch (status) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "merge_conflict":
      return "merge conflict";
    case "success":
      return "green";
    case "pending":
      return rollupSummary || "pending";
    case "failure":
      return rollupSummary || "failed";
    default:
      return rollupSummary || status;
  }
}

function statusFromGhView(
  pr: GhPrViewFields,
  ciRollup: CiRollupStatus,
  ciSummary: string,
): Omit<CiStatusInfo, "checkedAt" | "source"> {
  const fromPr = resolveDisplayStatus(pr, ciRollup);
  const status = fromPr.status;
  return {
    status,
    summary: ciSummaryLabel(status, ciSummary),
    checksUrl: pr.url,
    mergedAt: fromPr.mergedAt ?? pr.mergedAt ?? null,
  };
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

type GhViewOk = {
  ok: true;
  pr: GhPrViewFields;
  ciRollup: CiRollupStatus;
  ciSummary: string;
};

type GhViewFail = { ok: false; reason: string };

async function fetchGhPrView(
  spawnCwd: string,
  repoSlug: string | null | undefined,
  target: { prNumber?: number | null; branch?: string },
  ghImpl: typeof gh = gh,
): Promise<GhViewOk | GhViewFail> {
  const ghArgs = buildGhPrViewArgs(repoSlug, target);
  if (!ghArgs) return { ok: false, reason: "no PR ref" };

  const ghRes = await ghImpl(spawnCwd, ghArgs);
  if (ghRes.code !== 0) {
    return { ok: false, reason: firstStderrLine(ghRes.stderr || ghRes.stdout) };
  }
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
    return { ok: false, reason: "invalid gh pr view JSON" };
  }
}

export type FetchPrCiTarget = {
  prNumber?: number | null;
  branch?: string;
  repoSlug?: string | null;
  prUrl?: string | null;
};

export type FetchPrCiDeps = {
  gh?: typeof gh;
  originCmd?: typeof originCmd;
};

export async function fetchPrCiStatus(
  cwd: string | null,
  target: FetchPrCiTarget,
  deps: FetchPrCiDeps = {},
): Promise<Omit<CiStatusInfo, "checkedAt">> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) {
    return { status: "unknown", summary: "CI unknown", reason: "no PR", source: "github" };
  }

  const repoSlug = target.repoSlug?.trim() || repoSlugFromPrUrl(target.prUrl) || null;
  const spawnCwd = cwd?.trim() || os.tmpdir();
  const ghImpl = deps.gh ?? gh;
  const originImpl = deps.originCmd ?? originCmd;

  const ghView = await fetchGhPrView(spawnCwd, repoSlug, target, ghImpl);
  if (ghView.ok) {
    return { ...statusFromGhView(ghView.pr, ghView.ciRollup, ghView.ciSummary), source: "github" };
  }

  if (cwd?.trim()) {
    const originRes = await originImpl(cwd, [
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
      return {
        status: rolled.status,
        summary: rolled.status === "success" ? "green" : rolled.summary,
        checksUrl,
        source: "origin",
      };
    }
  }

  return {
    status: "unknown",
    summary: "CI unknown",
    reason: ghView.reason,
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
