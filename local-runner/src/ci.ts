import os from "node:os";
import type { CiRollupStatus, CiStatusInfo, JobRecord } from "./types.js";
import { ghRaw, type GhResult } from "./github.js";
import type { GhFn } from "./github-rate-limit.js";
import { ghWithGithubRetry } from "./github-rate-limit.js";
import {
  resolveRepoSlug,
  restFetchCheckRunsForRef,
  restFindOpenPrForBranch,
  restGetPull,
  type CheckRunRow,
} from "./github-rest.js";
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

type RestViewOk = {
  ok: true;
  pr: GhPrViewFields;
  ciRollup: CiRollupStatus;
  ciSummary: string;
};

type RestViewFail = { ok: false; reason: string };

function checkRunToRow(row: CheckRunRow): CheckRow {
  return {
    name: row.name,
    status: row.status,
    conclusion: row.conclusion ?? undefined,
    detailsUrl: row.details_url ?? row.html_url,
  };
}

async function resolvePullNumber(
  spawnCwd: string,
  repoSlug: string | null,
  target: { prNumber?: number | null; branch?: string },
  ghFn: typeof ghRaw,
): Promise<number | null> {
  if (target.prNumber != null) return target.prNumber;
  const branch = target.branch?.trim();
  if (!branch) return null;
  const found = await restFindOpenPrForBranch(spawnCwd, branch, repoSlug, (c, a) =>
    ghWithGithubRetry(c, a, ghFn),
  );
  return found?.number ?? null;
}

async function fetchPrCiViaRest(
  spawnCwd: string,
  repoSlug: string | null | undefined,
  target: { prNumber?: number | null; branch?: string },
  ghFn: GhFn = ghRaw,
): Promise<RestViewOk | RestViewFail> {
  const slug = resolveRepoSlug(repoSlug, null);
  const prNumber = await resolvePullNumber(spawnCwd, slug, target, ghFn);
  if (prNumber == null) return { ok: false, reason: "no PR ref" };

  const pull = await restGetPull(spawnCwd, prNumber, slug, (c, a) => ghWithGithubRetry(c, a, ghFn));
  if (!pull) return { ok: false, reason: "REST pull lookup failed" };

  const pr: GhPrViewFields = {
    state: (pull.state ?? "").toUpperCase(),
    mergedAt: pull.merged_at ?? null,
    mergeable:
      pull.mergeable === false
        ? "CONFLICTING"
        : pull.mergeable_state?.toUpperCase() === "DIRTY"
          ? "CONFLICTING"
          : "MERGEABLE",
    url: pull.html_url,
  };

  const headSha = pull.head?.sha?.trim();
  let ciRollup: CiRollupStatus = "unknown";
  let ciSummary = "no checks";
  if (headSha) {
    const runs = await restFetchCheckRunsForRef(spawnCwd, headSha, slug, (c, a) =>
      ghWithGithubRetry(c, a, ghFn),
    );
    const rolled = rollupCheckStatuses(runs.map(checkRunToRow));
    ciRollup = rolled.status;
    ciSummary = rolled.summary;
  }

  return { ok: true, pr, ciRollup, ciSummary };
}

export type FetchPrCiTarget = {
  prNumber?: number | null;
  branch?: string;
  repoSlug?: string | null;
  prUrl?: string | null;
};

export type FetchPrCiDeps = {
  gh?: GhFn;
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
  const originImpl = deps.originCmd ?? originCmd;

  const restGh = deps.gh ?? ghRaw;
  const restView = await fetchPrCiViaRest(spawnCwd, repoSlug, target, restGh);
  if (restView.ok) {
    return {
      ...statusFromGhView(restView.pr, restView.ciRollup, restView.ciSummary),
      source: "github",
    };
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
    reason: restView.reason,
    source: "github",
  };
}

const CI_ACTIVE_STAGES = new Set(["building", "reviewing", "fixing", "approved"]);

const MERGE_WATCH_STAGES = new Set(["approved", "changes_remaining", "stuck", "failed", "stopped"]);

export function shouldPollCi(job: JobRecord): boolean {
  if (job.input.jobType === "docs" || job.input.profile === "docs") return false;

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
