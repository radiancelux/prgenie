import type { CiRollupStatus, CiStatusInfo, JobRecord } from "./types.js";
import { isCiFinal } from "./ci.js";
import type { DocChecksConfig } from "./docs-settings.js";
import { parseDocsSettings } from "./docs-settings.js";
import type { RunnerSettings } from "./settings.js";
import { git } from "./github.js";
import { spawnCommand } from "./spawn-cmd.js";

export function isDocsJob(job: JobRecord): boolean {
  return job.input.jobType === "docs" || job.input.profile === "docs";
}

export function docChecksConfigFromSettings(settings: RunnerSettings): DocChecksConfig {
  return parseDocsSettings(settings).docChecks;
}

const DOC_ACTIVE_STAGES = new Set(["building", "reviewing", "fixing", "approved"]);
const DOC_WATCH_STAGES = new Set(["approved", "changes_remaining", "stuck", "failed", "stopped"]);

export function shouldPollDocChecks(job: JobRecord): boolean {
  if (!isDocsJob(job)) return false;
  const hasPr = job.prNumber != null || job.prUrl != null;
  if (!hasPr) return false;
  if (job.ciStatus?.status === "merged") return false;
  if (DOC_WATCH_STAGES.has(job.stage)) return true;
  if (job.ciStatus && isCiFinal(job.ciStatus.status)) return false;
  if (DOC_ACTIVE_STAGES.has(job.stage)) return true;
  return false;
}

export async function listChangedMarkdownPaths(cwd: string): Promise<string[]> {
  const base = await git(cwd, ["merge-base", "HEAD", "origin/main"]);
  let diffArgs = ["diff", "--name-only", "origin/main...HEAD"];
  if (base.code === 0 && base.stdout.trim()) {
    diffArgs = ["diff", "--name-only", `${base.stdout.trim()}...HEAD`];
  }
  const diff = await git(cwd, diffArgs);
  if (diff.code !== 0) {
    const fallback = await git(cwd, ["diff", "--name-only", "HEAD~1..HEAD"]);
    if (fallback.code !== 0) return [];
    return fallback.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".md"));
  }
  return diff.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".md"));
}

export type DocCheckRunResult = {
  ok: boolean;
  skipped: boolean;
  summary: string;
  detail?: string;
};

export async function runMarkdownDocChecks(
  cwd: string,
  paths: string[],
): Promise<DocCheckRunResult> {
  if (paths.length === 0) {
    return { ok: true, skipped: true, summary: "no markdown changed" };
  }
  const args = ["--yes", "markdownlint-cli2", ...paths];
  const res = await spawnCommand("npx", cwd, args);
  if (res.code === 0) {
    return { ok: true, skipped: false, summary: `lint ok (${paths.length} file(s))` };
  }
  const err = (res.stderr || res.stdout).trim().slice(0, 400);
  if (/ENOENT|not found|could not determine executable/i.test(err)) {
    return { ok: true, skipped: true, summary: "markdownlint not available" };
  }
  return { ok: false, skipped: false, summary: "markdown lint failed", detail: err };
}

export function rollupDocCheckResult(
  result: DocCheckRunResult,
  config: DocChecksConfig,
): { status: CiRollupStatus; summary: string; reason?: string } {
  if (!config.enabled) {
    return { status: "success", summary: "N/A" };
  }
  if (result.skipped && result.ok) {
    return { status: "success", summary: result.summary };
  }
  if (result.ok) {
    return { status: "success", summary: result.summary };
  }
  if (config.failHard) {
    return { status: "failure", summary: result.summary, reason: result.detail };
  }
  return { status: "neutral", summary: `soft: ${result.summary}`, reason: result.detail };
}

export async function fetchDocChecksStatus(
  cwd: string | null,
  config: DocChecksConfig,
): Promise<Omit<CiStatusInfo, "checkedAt">> {
  if (!config.enabled) {
    return { status: "success", summary: "N/A", source: "doc-checks" };
  }
  if (!cwd?.trim()) {
    return {
      status: "unknown",
      summary: "Doc checks unknown",
      reason: "no worktree",
      source: "doc-checks",
    };
  }
  const paths = await listChangedMarkdownPaths(cwd);
  const result = await runMarkdownDocChecks(cwd, paths);
  const rolled = rollupDocCheckResult(result, config);
  return {
    status: rolled.status,
    summary: rolled.summary,
    reason: rolled.reason,
    source: "doc-checks",
  };
}
