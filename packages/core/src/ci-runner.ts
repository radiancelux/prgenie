import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getCachedResult, recordCheckPass } from "./ci-cache.js";
import {
  collectExecOutput,
  formatCiCheckError,
  formatFailureExcerpt,
  writeCiFailureLog,
} from "./ci-failure.js";
import {
  changedPathsForCi,
  envFlag,
  resolveCiCwd,
  selectCiChecks,
  type CiCheckSelection,
} from "./ci-select.js";
import { getLocalPr } from "./prs.js";
import {
  abortError,
  ciCheckCommand,
  isAbortError,
  onAbort,
  throwIfAborted,
  type ProgressCallback,
} from "./progress.js";

const execAsync = promisify(exec);

export interface CiCheckResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  error?: string;
  /** Short toast/CLI excerpt (first failing test or last N lines). */
  excerpt?: string;
  /** Relative or absolute path to the capped full log. */
  logPath?: string;
  elapsedMs?: number;
  reason?: string;
}

export interface CiRunnerResult {
  allPassed: boolean;
  checks: CiCheckResult[];
  selection?: CiCheckSelection;
}

export interface CiRunnerOptions {
  /** Override the default CI checks */
  checks?: string[];
  /** Timeout per check in milliseconds. Default 300000 (5 minutes) */
  timeout?: number;
  /** Skip cache and force all checks to run (for testing). Default false. */
  skipCache?: boolean;
  /** Live progress for CLI / sidebar (RAD-73). */
  onProgress?: ProgressCallback;
  /** Cancel in-flight checks (kills the child process). */
  signal?: AbortSignal;
  /**
   * Stop remaining checks after the first failure (RAD-77).
   * Default true, or PRGENIE_CI_FAIL_FAST=0 to disable.
   */
  failFast?: boolean;
  /**
   * Run independent checks concurrently (RAD-77).
   * Default true, or PRGENIE_CI_PARALLEL=0 to disable.
   */
  parallel?: boolean;
  /** Smart-CI plan already computed by the caller. */
  selection?: CiCheckSelection;
  /** Changed paths used when the caller wants selection recorded. */
  changedPaths?: string[];
}

/**
 * Get list of git-tracked files for format checking.
 * This ensures local CI matches remote CI (clean checkout).
 * Filters to only include files prettier can check.
 */
async function getTrackedFiles(cwd: string): Promise<string[]> {
  try {
    // Get all tracked files, excluding submodules and symlinks
    const { stdout } = await execAsync("git ls-files --exclude-standard", { cwd });
    const files = stdout.trim().split("\n").filter(Boolean);

    // Filter out files that prettier can't or shouldn't check
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const validFiles: string[] = [];

    // Files/patterns prettier can't parse or that are typically ignored
    const skipFiles = new Set([
      ".gitignore",
      ".prettierignore",
      ".eslintignore",
      ".dockerignore",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
    ]);

    // Common extensions prettier can format (to avoid passing files it can't parse)
    const prettierExts = new Set([
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".mjs",
      ".cjs",
      ".json",
      ".css",
      ".scss",
      ".less",
      ".html",
      ".md",
      ".yml",
      ".yaml",
      ".xml",
    ]);

    for (const file of files) {
      const basename = path.basename(file);
      const ext = path.extname(file).toLowerCase();

      // Skip files prettier explicitly can't parse
      if (skipFiles.has(basename)) {
        continue;
      }

      // Only include files with extensions prettier knows about
      if (!prettierExts.has(ext)) {
        continue;
      }

      try {
        const fullPath = path.join(cwd, file);
        const stats = await fs.stat(fullPath);
        // Only include regular files (not symlinks, directories, etc)
        if (stats.isFile()) {
          validFiles.push(file);
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return validFiles;
  } catch {
    return [];
  }
}

/**
 * Check format for tracked files using git blob content (LF-normalized).
 * RAD-46: This ensures Windows autocrlf repos pass when blob content is properly formatted,
 * even when working tree files have CRLF line endings.
 */
async function checkFormatFromBlobs(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<void> {
  const failures: string[] = [];

  for (const file of files) {
    throwIfAborted(signal);
    try {
      // Use git show :file to get the index/blob version (LF-normalized)
      // Pipe to prettier --stdin-filepath to check formatting
      const command = `git show ":${file.replace(/"/g, '\\"')}" | pnpm exec prettier --stdin-filepath "${file.replace(/"/g, '\\"')}" --check`;
      await execAsync(command, { cwd, signal });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw abortError();
      failures.push(file);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Prettier format check failed for ${failures.length} file(s): ${failures.slice(0, 5).join(", ")}${failures.length > 5 ? "..." : ""}`,
    );
  }
}

function skippedResult(check: string, reason?: string): CiCheckResult {
  return { name: check, passed: true, skipped: true, reason };
}

async function runOneCheck(
  cwd: string,
  check: string,
  options: {
    timeout: number;
    skipCache: boolean;
    onProgress?: ProgressCallback;
    signal?: AbortSignal;
    reason?: string;
  },
): Promise<CiCheckResult> {
  const { timeout, skipCache, onProgress, signal, reason } = options;
  const command = ciCheckCommand(check);

  if (!skipCache) {
    const cached = await getCachedResult(cwd, check);
    if (cached) {
      onProgress?.({ phase: "ci", check, state: "cached", command, elapsedMs: 0 });
      return { name: check, passed: true, elapsedMs: 0, reason };
    }
  }

  throwIfAborted(signal);
  onProgress?.({ phase: "ci", check, state: "start", command });
  const started = Date.now();

  try {
    if (check === "format:check") {
      const tracked = await getTrackedFiles(cwd);
      if (tracked.length > 0) {
        await checkFormatFromBlobs(cwd, tracked, signal);
        const elapsedMs = Date.now() - started;
        onProgress?.({ phase: "ci", check, state: "pass", command, elapsedMs });
        try {
          await recordCheckPass(cwd, check);
        } catch {
          // Check passed; cache write failed — ignore and continue without cache
        }
        return { name: check, passed: true, elapsedMs, reason };
      }
    }

    await execAsync(command, { cwd, timeout, signal, maxBuffer: 2 * 1024 * 1024 });
    const elapsedMs = Date.now() - started;
    onProgress?.({ phase: "ci", check, state: "pass", command, elapsedMs });
    try {
      await recordCheckPass(cwd, check);
    } catch {
      // Check passed; cache write failed — ignore and continue without cache
    }
    return { name: check, passed: true, elapsedMs, reason };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw abortError();
    const output = collectExecOutput(err);
    const excerpt = formatFailureExcerpt(check, output);
    const logPath = await writeCiFailureLog(cwd, check, command, output, excerpt);
    const elapsedMs = Date.now() - started;
    const error = formatCiCheckError({ command, excerpt, logPath });
    onProgress?.({
      phase: "ci",
      check,
      state: "fail",
      command,
      elapsedMs,
      message: excerpt,
      logPath: logPath ?? undefined,
    });
    return {
      name: check,
      passed: false,
      error,
      excerpt,
      logPath: logPath ?? undefined,
      elapsedMs,
      reason,
    };
  }
}

/**
 * Run local CI checks. Discovers checks from package.json/CI workflow.
 * For prgenie: format:check, lint, typecheck, test, build
 *
 * RAD-35: Implements cache/incremental CI - skips checks when inputs unchanged.
 * RAD-36: format:check runs over git-tracked files only (matching remote CI clean checkout).
 * RAD-46: format:check checks git blob (LF-normalized) content, not CRLF working tree.
 * RAD-77: fail-fast (default), parallel independent checks, smart selection via caller.
 */
export async function runCiChecks(
  cwd: string,
  options: CiRunnerOptions = {},
): Promise<CiRunnerResult> {
  const checks = options.checks ?? ["format:check", "lint", "typecheck", "test", "build"];
  const timeout = options.timeout ?? 300000;
  const skipCache = options.skipCache ?? false;
  const onProgress = options.onProgress;
  const signal = options.signal;
  const failFast = options.failFast ?? envFlag("PRGENIE_CI_FAIL_FAST", true);
  const parallel = options.parallel ?? envFlag("PRGENIE_CI_PARALLEL", true);
  const selection = options.selection;
  const reasonFor = (name: string): string | undefined =>
    selection?.mapping.find((m) => m.check === name)?.reason ?? selection?.reason;

  if (selection) {
    onProgress?.({
      phase: "ci",
      state: "start",
      selectedChecks: selection.checks,
      selectionReason: selection.reason,
    });
  } else {
    onProgress?.({
      phase: "ci",
      state: "start",
      selectedChecks: checks,
      selectionReason: options.changedPaths ? "caller-provided check list" : "configured suite",
    });
  }

  const results: CiCheckResult[] = [];

  if (parallel && checks.length > 1) {
    const child = new AbortController();
    const detach = onAbort(signal, () => child.abort());
    try {
      const pending = checks.map((check) =>
        runOneCheck(cwd, check, {
          timeout,
          skipCache,
          onProgress,
          signal: child.signal,
          reason: reasonFor(check),
        }).then((result) => {
          if (!result.passed && failFast) child.abort();
          return result;
        }),
      );
      const settled = await Promise.allSettled(pending);
      for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        const check = checks[i];
        if (item.status === "fulfilled") {
          results.push(item.value);
        } else if (isAbortError(item.reason) || child.signal.aborted) {
          onProgress?.({ phase: "ci", check, state: "skip" });
          results.push(skippedResult(check, "fail-fast — not started or cancelled"));
        } else {
          throw item.reason;
        }
      }
    } finally {
      detach();
    }
  } else {
    for (const check of checks) {
      throwIfAborted(signal);
      if (failFast && results.some((r) => !r.passed && !r.skipped)) {
        onProgress?.({ phase: "ci", check, state: "skip" });
        results.push(skippedResult(check, "fail-fast — earlier check failed"));
        continue;
      }
      try {
        results.push(
          await runOneCheck(cwd, check, {
            timeout,
            skipCache,
            onProgress,
            signal,
            reason: reasonFor(check),
          }),
        );
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw abortError();
        throw err;
      }
    }
  }

  return {
    allPassed: results.every((r) => r.passed),
    checks: results,
    selection,
  };
}

export interface LoopCiOptions extends CiRunnerOptions {
  /** Extra checks that must run (CI-resume failing names). */
  failingChecks?: string[];
}

/**
 * Implementor preflight / CI-resume: smart-select from the loop diff, run in the worktree.
 */
export async function runLoopCi(
  cwd: string,
  id: string,
  options: LoopCiOptions = {},
): Promise<CiRunnerResult> {
  const pr = await getLocalPr(cwd, id);
  const ciCwd = resolveCiCwd(cwd, pr.worktreePath);
  const paths = options.changedPaths ?? (await changedPathsForCi(ciCwd, id));
  const selection = options.selection ?? selectCiChecks(paths);
  const extra = (options.failingChecks ?? []).map((name) => name.trim()).filter(Boolean);
  const checks = options.checks ?? [...new Set([...selection.checks, ...extra])];
  return runCiChecks(ciCwd, { ...options, checks, selection, changedPaths: paths });
}
