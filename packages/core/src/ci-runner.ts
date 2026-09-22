import { exec } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
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
  formatCiSelectionReason,
  resolveCiCwd,
  selectCiChecks,
  type CiCheckSelection,
} from "./ci-select.js";
import { requestCiAbort, watchCiAbort } from "./ci-abort.js";
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

/**
 * Resolve prettier from the CI repo cwd, not the MCP/CLI bundle location.
 * Bundles mark prettier external; linked-plugin installs under ~/.cursor/plugins
 * have no node_modules, so bare `import("prettier")` fails MODULE_NOT_FOUND.
 */
export function resolvePrettierFromCwd(cwd: string): string {
  return createRequire(path.join(cwd, "package.json")).resolve("prettier");
}

function loadPrettierFromCwd(cwd: string): typeof import("prettier") {
  // require() (not import()) so CJS prettier exports land on the return value,
  // not under `.default` the way `import(fileURL)` of index.cjs does.
  return createRequire(path.join(cwd, "package.json"))("prettier") as typeof import("prettier");
}

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
  /** Timeout per check in milliseconds. Default 600000 (10 minutes) */
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
    const { stdout } = await execAsync("git ls-files --exclude-standard", {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
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
  } catch (err) {
    throw new Error(
      `Failed to list tracked files for format:check: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Check format for tracked files using git blob content (LF-normalized).
 * RAD-46: This ensures Windows autocrlf repos pass when blob content is properly formatted,
 * even when working tree files have CRLF line endings.
 *
 * Uses the Prettier API (not per-file `pnpm exec`) so Windows CI does not pay
 * ~100× process startup costs.
 */
async function checkFormatFromBlobs(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<void> {
  const prettier = loadPrettierFromCwd(cwd);
  const failures: string[] = [];

  for (const file of files) {
    throwIfAborted(signal);
    try {
      const filepath = path.join(cwd, file);
      const info = await prettier.getFileInfo(filepath, {
        ignorePath: path.join(cwd, ".prettierignore"),
      });
      if (info.ignored || info.inferredParser == null) continue;

      const shown = await execAsync(`git show ":${file.replace(/"/g, '\\"')}"`, {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        signal,
      });
      const source = typeof shown.stdout === "string" ? shown.stdout : String(shown.stdout);
      const config = await prettier.resolveConfig(filepath);
      const ok = await prettier.check(source, {
        ...(config ?? {}),
        filepath,
      });
      if (!ok) failures.push(file);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw abortError();
      const detail = err instanceof Error ? err.message : String(err);
      failures.push(`${file} (${detail})`);
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
  const timeout = options.timeout ?? 600000;
  const skipCache = options.skipCache ?? false;
  const onProgress = options.onProgress;
  const signal = options.signal;
  const failFast = options.failFast ?? envFlag("PRGENIE_CI_FAIL_FAST", true);
  const selection = options.selection;
  // Package-scoped suites run sequentially so fail-fast stops after the first package fail.
  const parallel =
    selection?.packageScoped === true
      ? false
      : (options.parallel ?? envFlag("PRGENIE_CI_PARALLEL", true));
  const reasonFor = (name: string): string | undefined => {
    const mapped = selection?.mapping.find((m) => m.check === name)?.reason;
    if (mapped) return mapped;
    const joined = formatCiSelectionReason(selection?.reason);
    return joined || undefined;
  };

  if (selection) {
    onProgress?.({
      phase: "ci",
      state: "start",
      selectedChecks: selection.checks,
      selectionReason: formatCiSelectionReason(selection.reason),
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
  const controller = new AbortController();
  const detach = onAbort(options.signal, () => {
    controller.abort();
    try {
      requestCiAbort(cwd, id);
    } catch {
      // ignore
    }
  });
  // Arm abort watch before path discovery — Cancel during startup must still land.
  const stopWatch = watchCiAbort(cwd, id, controller);
  try {
    throwIfAborted(controller.signal);
    const pr = await getLocalPr(cwd, id);
    throwIfAborted(controller.signal);
    const ciCwd = resolveCiCwd(cwd, pr.worktreePath);
    const paths = options.changedPaths ?? (await changedPathsForCi(ciCwd, id));
    throwIfAborted(controller.signal);
    const selection = options.selection ?? selectCiChecks(paths);
    const extra = (options.failingChecks ?? []).map((name) => name.trim()).filter(Boolean);
    const checks = options.checks ?? [...new Set([...selection.checks, ...extra])];
    throwIfAborted(controller.signal);
    return await runCiChecks(ciCwd, {
      ...options,
      checks,
      selection,
      changedPaths: paths,
      signal: controller.signal,
    });
  } finally {
    stopWatch();
    detach();
  }
}
