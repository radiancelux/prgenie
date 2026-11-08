import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { childProcessSpawnOptions } from "./spawn-options.js";
import { promisify } from "node:util";
import type { RunnerSettings } from "./settings.js";
import { findDriverEntry } from "./settings.js";
import { binaryOnPath } from "./drivers/driver-types.js";
import { git, type GhResult } from "./github.js";
import type { ResolvedJobTarget } from "./job-target.js";
import { isGitHubRemoteUrl } from "./repo-display.js";
import type { StartJobArgs } from "./types.js";

const execFileAsync = promisify(execFile);

export const JOB_PREFLIGHT_DOCTOR_HINT = "Run `prgenie doctor` for a full setup report.";

export type JobPreflightIssue = {
  id: string;
  message: string;
};

export type JobPreflightResult = {
  /** No blocking issues (real jobs refuse start when false). */
  ok: boolean;
  blocking: JobPreflightIssue[];
  /** Dry-run only: setup gaps reported without refusing start. */
  warnings: JobPreflightIssue[];
};

export type JobPreflightDeps = {
  access?: (path: string) => Promise<void>;
  git?: (cwd: string, args: string[]) => Promise<GhResult>;
  binaryOnPath?: (name: string) => Promise<boolean>;
  ghAuthStatus?: () => Promise<"ok" | "missing" | "not_logged_in" | "error">;
};

export function formatJobPreflightMessage(issue: JobPreflightIssue): string {
  return `${issue.message} ${JOB_PREFLIGHT_DOCTOR_HINT}`;
}

export function formatJobPreflightErrors(issues: JobPreflightIssue[]): string {
  return issues.map(formatJobPreflightMessage).join("; ");
}

async function defaultGhAuthStatus(): Promise<"ok" | "missing" | "not_logged_in" | "error"> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "gh",
      ["auth", "status"],
      childProcessSpawnOptions({ timeout: 15_000 }),
    );
    const text = `${stdout}${stderr}`;
    if (/logged in to/i.test(text)) return "ok";
    return "not_logged_in";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(msg)) return "missing";
    return "error";
  }
}

function driverBinaryName(settings: RunnerSettings, driverId: string): string | null {
  const entry = findDriverEntry(settings, driverId);
  if (!entry) return null;
  const binary = entry.binary?.trim();
  if (binary) return binary;
  if (entry.kind === "cursor-agent") return "cursor-agent";
  if (entry.kind === "claude-code") return "claude";
  if (entry.kind === "local-model") return entry.binary?.trim() || "ollama";
  return null;
}

/** Checks that apply before worktree creation; reused for dry-run warnings (#156 / #158). */
export async function runJobStartPreflight(
  target: Extract<ResolvedJobTarget, { ok: true }>,
  args: Pick<StartJobArgs, "driver" | "jobType" | "profile" | "dryRun">,
  settings: RunnerSettings,
  effectiveDryRun: boolean,
  deps: JobPreflightDeps = {},
): Promise<JobPreflightResult> {
  const accessImpl = deps.access ?? ((p: string) => access(p));
  const gitImpl = deps.git ?? git;
  const binaryImpl = deps.binaryOnPath ?? binaryOnPath;
  const ghStatus = deps.ghAuthStatus ?? defaultGhAuthStatus;

  const blocking: JobPreflightIssue[] = [];
  const warnings: JobPreflightIssue[] = [];
  const push = (issue: JobPreflightIssue, block: boolean) => {
    if (block) blocking.push(issue);
    else warnings.push(issue);
  };

  const repoPath = target.repoPath?.trim();
  const remote = target.remote?.trim();

  if (repoPath) {
    try {
      await accessImpl(repoPath);
    } catch {
      push(
        {
          id: "repo-missing",
          message: `repoPath does not exist: ${repoPath}`,
        },
        true,
      );
      return finalize(blocking, warnings);
    }
    const inside = await gitImpl(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      push(
        {
          id: "repo-not-git",
          message: `repoPath is not a git work tree: ${repoPath}`,
        },
        true,
      );
      return finalize(blocking, warnings);
    }
  }

  const report = (issue: JobPreflightIssue) => push(issue, !effectiveDryRun);

  if (repoPath) {
    const origin = await gitImpl(repoPath, ["remote", "get-url", "origin"]);
    if (origin.code !== 0 || !origin.stdout.trim()) {
      report({
        id: "origin-missing",
        message: 'Repo has no "origin" remote: add one with git remote add origin <github url>',
      });
    } else {
      const url = origin.stdout.trim();
      if (!isGitHubRemoteUrl(url)) {
        report({
          id: "origin-not-github",
          message: `origin remote is not a GitHub URL (${url}) — PR flow requires github.com`,
        });
      }
    }
  } else if (remote) {
    if (!isGitHubRemoteUrl(remote)) {
      report({
        id: "remote-not-github",
        message: `remote is not a GitHub URL (${remote}) — PR flow requires github.com`,
      });
    }
  }

  const auth = await ghStatus();
  if (auth === "missing") {
    report({ id: "gh-missing", message: "gh is not installed" });
  } else if (auth === "not_logged_in" || auth === "error") {
    report({ id: "gh-auth", message: "gh is not logged in: run gh auth login" });
  }

  const driverId = args.driver?.trim() || settings.defaultDriver || "cursor-agent";
  const binary = driverBinaryName(settings, driverId);
  if (binary && !(await binaryImpl(binary))) {
    report({
      id: "driver-binary",
      message: `${binary} not found on PATH (driver ${driverId})`,
    });
  } else if (!binary && !findDriverEntry(settings, driverId)) {
    report({
      id: "driver-unknown",
      message: `Unknown driver: ${driverId}`,
    });
  }

  return finalize(blocking, warnings);
}

function finalize(
  blocking: JobPreflightIssue[],
  warnings: JobPreflightIssue[],
): JobPreflightResult {
  return {
    ok: blocking.length === 0,
    blocking,
    warnings: warnings.map((w) => w),
  };
}

export type PrSetupDiagnosis = {
  hints: string[];
};

/** When PR creation still fails after build, name likely setup gaps (#156). */
export async function diagnosePrSetupIssues(
  repoPath: string | null | undefined,
  deps: JobPreflightDeps = {},
): Promise<PrSetupDiagnosis> {
  const hints: string[] = [];
  const root = repoPath?.trim();
  const gitImpl = deps.git ?? git;
  const ghStatus = deps.ghAuthStatus ?? defaultGhAuthStatus;

  if (!root) {
    hints.push("no local repo checkout (remote-only job)");
    return { hints };
  }

  const origin = await gitImpl(root, ["remote", "get-url", "origin"]);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    hints.push('repo has no "origin" remote');
  } else if (!isGitHubRemoteUrl(origin.stdout.trim())) {
    hints.push("origin is not a GitHub URL");
  }

  const auth = await ghStatus();
  if (auth === "missing") hints.push("gh is not installed");
  else if (auth !== "ok") hints.push("gh is not logged in");

  return { hints };
}

export function enrichNoPrGuardMessage(base: string, diagnosis: PrSetupDiagnosis): string {
  if (!diagnosis.hints.length) return `${base} ${JOB_PREFLIGHT_DOCTOR_HINT}`;
  return `${base} (likely: ${diagnosis.hints.join("; ")}) ${JOB_PREFLIGHT_DOCTOR_HINT}`;
}
