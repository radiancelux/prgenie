import { spawn } from "node:child_process";
import type { CiRollupStatus, CiStatusInfo, JobRecord } from "./types.js";
import { gh, type GhResult } from "./github.js";

export type CheckRow = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
};

export function isCiFinal(status: CiRollupStatus): boolean {
  return status === "success" || status === "failure" || status === "neutral";
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
  return new Promise((resolve) => {
    const child = spawn("origin", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => resolve({ code: 127, stdout: "", stderr: "origin not found" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
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

export async function fetchPrCiStatus(
  cwd: string,
  target: { prNumber?: number | null; branch?: string },
): Promise<Omit<CiStatusInfo, "checkedAt">> {
  const ref =
    target.prNumber != null ? String(target.prNumber) : target.branch?.trim() || undefined;
  if (!ref) {
    return { status: "unknown", summary: "no PR", source: "github" };
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
    return {
      status: rolled.status,
      summary: rolled.summary,
      checksUrl,
      source: "origin",
    };
  }

  const ghArgs =
    target.prNumber != null
      ? ["pr", "view", String(target.prNumber), "--json", "statusCheckRollup,url"]
      : ["pr", "view", ref, "--json", "statusCheckRollup,url"];
  const ghRes = await gh(cwd, ghArgs);
  if (ghRes.code !== 0) {
    return {
      status: "unknown",
      summary: "CI lookup failed",
      source: "github",
    };
  }
  try {
    const parsed = JSON.parse(ghRes.stdout) as {
      url?: string;
      statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
    };
    const rolled = rollupFromGithubStatusCheckRollup(parsed.statusCheckRollup ?? []);
    return {
      status: rolled.status,
      summary: rolled.summary,
      checksUrl: parsed.url,
      source: "github",
    };
  } catch {
    return { status: "unknown", summary: "CI parse failed", source: "github" };
  }
}

const CI_ACTIVE_STAGES = new Set(["building", "reviewing", "fixing", "approved"]);

export function shouldPollCi(job: JobRecord): boolean {
  const hasPr = job.prNumber != null || job.prUrl != null;
  if (!hasPr) return false;

  if (job.ciStatus && isCiFinal(job.ciStatus.status)) {
    if (CI_ACTIVE_STAGES.has(job.stage)) return false;
    return false;
  }

  if (CI_ACTIVE_STAGES.has(job.stage)) return true;

  if (["changes_remaining", "stuck", "failed", "stopped"].includes(job.stage)) {
    if ((job.stage === "failed" || job.stage === "stopped") && !job.prUrl && job.prNumber == null) {
      return false;
    }
    return true;
  }

  return false;
}
