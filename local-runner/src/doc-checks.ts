import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CiRollupStatus, CiStatusInfo, DocLintFinding, JobRecord } from "./types.js";
import { DOC_LINT_FINDINGS_CAP } from "./types.js";
import { isCiFinal } from "./ci.js";
import type { DocChecksConfig } from "./docs-settings.js";
import { parseDocsSettings } from "./docs-settings.js";
import type { RunnerSettings } from "./settings.js";
import { git } from "./github.js";
import { spawnCommand } from "./spawn-cmd.js";

let proseDefaultsCached: string | undefined;

/** Resolved at runtime (dist bundle copies jsonc next to runner.cjs). */
export function proseMarkdownlintConfigPath(): string {
  if (proseDefaultsCached) return proseDefaultsCached;
  const candidates: string[] = [];
  if (process.argv[1]) {
    candidates.push(path.join(path.dirname(process.argv[1]), "markdownlint-prose-defaults.jsonc"));
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      candidates.push(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "markdownlint-prose-defaults.jsonc",
        ),
      );
    }
  } catch {
    /* bundled cjs — import.meta empty */
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      proseDefaultsCached = c;
      return c;
    }
  }
  proseDefaultsCached = candidates[0] ?? "markdownlint-prose-defaults.jsonc";
  return proseDefaultsCached;
}

const MARKDOWNLINT_CONFIG_NAMES = [
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml",
  ".markdownlint.jsonc",
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.yml",
];

const FINDING_LINE = /^(.+?):(\d+)(?::(\d+))?\s+(?:error|warning)\s+([^\s]+)\s+(.+)$/;

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

export async function repoHasMarkdownlintConfig(cwd: string): Promise<boolean> {
  for (const name of MARKDOWNLINT_CONFIG_NAMES) {
    try {
      await access(path.join(cwd, name));
      return true;
    } catch {
      /* not present */
    }
  }
  return false;
}

export function parseMarkdownlintFindings(output: string): {
  findings: DocLintFinding[];
  truncated: boolean;
} {
  const findings: DocLintFinding[] = [];
  let truncated = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(FINDING_LINE);
    if (!m) continue;
    findings.push({
      file: m[1],
      line: Number(m[2]),
      column: m[3] ? Number(m[3]) : undefined,
      rule: m[4],
      message: m[5],
    });
    if (findings.length >= DOC_LINT_FINDINGS_CAP) {
      truncated = true;
      break;
    }
  }
  return { findings, truncated };
}

export type DocCheckRunResult = {
  ok: boolean;
  skipped: boolean;
  summary: string;
  detail?: string;
  findings?: DocLintFinding[];
  findingsTruncated?: boolean;
};

export async function runMarkdownDocChecks(
  cwd: string,
  paths: string[],
  options?: { proseDefaultsPath?: string; hasRepoConfig?: boolean },
): Promise<DocCheckRunResult> {
  if (paths.length === 0) {
    return { ok: true, skipped: true, summary: "no markdown changed" };
  }
  const hasRepoConfig =
    options?.hasRepoConfig !== undefined
      ? options.hasRepoConfig
      : await repoHasMarkdownlintConfig(cwd);
  const args = ["--yes", "markdownlint-cli2"];
  if (!hasRepoConfig) {
    args.push("--config", options?.proseDefaultsPath ?? proseMarkdownlintConfigPath());
  }
  args.push(...paths);
  const res = await spawnCommand("npx", cwd, args);
  if (res.code === 0) {
    return { ok: true, skipped: false, summary: `lint ok (${paths.length} file(s))` };
  }
  const combined = (res.stderr || res.stdout).trim();
  if (/ENOENT|not found|could not determine executable/i.test(combined)) {
    return { ok: true, skipped: true, summary: "markdownlint not available" };
  }
  const { findings, truncated } = parseMarkdownlintFindings(combined);
  const detail =
    findings.length > 0
      ? `${findings.length} finding(s)${truncated ? ` (cap ${DOC_LINT_FINDINGS_CAP})` : ""}`
      : combined.slice(0, 2000);
  return {
    ok: false,
    skipped: false,
    summary: "markdown lint failed",
    detail,
    findings: findings.length ? findings : undefined,
    findingsTruncated: truncated || undefined,
  };
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
  return {
    status: "neutral",
    summary: `warning (non-blocking): ${result.summary}`,
    reason: result.detail,
  };
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
    findings: result.findings,
    findingsTruncated: result.findingsTruncated,
  };
}
