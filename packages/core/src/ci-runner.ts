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
  shouldScopeFormatCheck,
  type CiCheckSelection,
} from "./ci-select.js";
import {
  hostScopeFailClosedReason,
  prettierPathsFromChanged,
  resolveCiCheckCommand,
} from "./ci-host-scope.js";
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
import {
  ensureWorktreeCiToolchain,
  formatToolchainSetupError,
  isCiEnvFailureOutput,
  type ToolchainEnsureResult,
} from "./worktree-deps.js";

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

/** Temp git fixtures and repos without a local prettier install. */
function isPrettierUnresolved(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "MODULE_NOT_FOUND" || /Cannot find module ['"]prettier['"]/.test(err.message);
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
  /** Env/setup failure (missing bins) vs product lint/test fail (RAD-92). */
  kind?: "product" | "env";
}

export interface CiRunnerResult {
  allPassed: boolean;
  checks: CiCheckResult[];
  selection?: CiCheckSelection;
  /** Absolute path CI actually ran in (loop worktree when present). */
  cwd: string;
  /**
   * True when CI could not run (or failed) because the worktree toolchain is missing.
   * Distinct from a product check fail — export gate soft-surfaces this by default (RAD-92).
   */
  envUnhealthy?: boolean;
  envMessage?: string;
  fixSteps?: string[];
  toolchain?: ToolchainEnsureResult;
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
  /** Skip auto-junction of primary node_modules (tests). */
  skipToolchainEnsure?: boolean;
  /** Forwarded to ensureWorktreeCiToolchain. */
  toolchainPrimaryPath?: string | null;
  allowToolchainInstall?: boolean;
  /**
   * Optional package.json scripts map for host-repo scoping (unit fixtures).
   * When omitted, scripts are read from `cwd/package.json`.
   */
  packageScripts?: Record<string, string> | null;
}

/**
 * Get list of git-tracked files for format checking.
 * This ensures local CI matches remote CI (clean checkout).
 * Filters to only include files prettier can check.
 *
 * When `onlyPaths` is set (RAD-117 scoped format), only those candidates are
 * considered — never the whole tracked tree.
 */
export async function getTrackedFiles(
  cwd: string,
  onlyPaths?: string[],
): Promise<string[]> {
  try {
    let files: string[];
    if (onlyPaths && onlyPaths.length > 0) {
      // Ask git which of the candidates are tracked (avoids full ls-files).
      const quoted = onlyPaths.map((p) => p.replace(/"/g, '\\"'));
      const { stdout } = await execAsync(
        `git ls-files --exclude-standard -- ${quoted.map((p) => `"${p}"`).join(" ")}`,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      files = stdout.trim().split("\n").filter(Boolean);
    } else if (onlyPaths && onlyPaths.length === 0) {
      return [];
    } else {
      // Get all tracked files, excluding submodules and symlinks
      const { stdout } = await execAsync("git ls-files --exclude-standard", {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      files = stdout.trim().split("\n").filter(Boolean);
    }

    // Filter out files that prettier can't or shouldn't check
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
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
      const basename = pathMod.basename(file);
      const ext = pathMod.extname(file).toLowerCase();

      // Skip files prettier explicitly can't parse
      if (skipFiles.has(basename)) {
        continue;
      }

      // Only include files with extensions prettier knows about
      if (!prettierExts.has(ext)) {
        continue;
      }

      try {
        const fullPath = pathMod.join(cwd, file);
        const stats = await fs.stat(fullPath);
        // Only include regular files (not symlinks, directories, etc)
        if (stats.isFile()) {
          validFiles.push(file.replace(/\\/g, "/"));
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return validFiles;
  } catch {
    // Not a git repo (unit fixtures) or ls-files failed — caller falls back to package script.
    return [];
  }
}

/**
 * Resolve which tracked prettier files format:check will blob-check.
 * Scoped plans use changed prettier-able paths only; full suite uses every tracked file.
 */
export async function resolveFormatCheckFiles(
  cwd: string,
  options: {
    changedPaths?: string[];
    formatScoped: boolean;
  },
): Promise<{ files: string[]; formatScoped: boolean }> {
  if (options.formatScoped) {
    const candidates = prettierPathsFromChanged(options.changedPaths ?? []);
    const files = await getTrackedFiles(cwd, candidates);
    return { files, formatScoped: true };
  }
  const files = await getTrackedFiles(cwd);
  return { files, formatScoped: false };
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
    changedPaths?: string[];
    packageScripts?: Record<string, string> | null;
    selection?: CiCheckSelection;
  },
): Promise<CiCheckResult> {
  const { timeout, skipCache, onProgress, signal, changedPaths, packageScripts, selection } =
    options;
  const formatScoped = check === "format:check" && shouldScopeFormatCheck(selection);
  const resolved = resolveCiCheckCommand({
    check,
    cwd,
    changedPaths,
    scripts: packageScripts,
    failClosedReason: hostScopeFailClosedReason(changedPaths) ?? undefined,
    formatScoped,
  });
  // Progress may show a descriptive blob-scope label; shell fallback stays pnpm <check>.
  const progressCommand = resolved.command;
  const shellCommand =
    check === "format:check" && formatScoped ? ciCheckCommand(check) : resolved.command;
  const reason = [options.reason, resolved.reason].filter(Boolean).join("; ");

  if (!skipCache) {
    const cached = await getCachedResult(cwd, check);
    if (cached) {
      onProgress?.({ phase: "ci", check, state: "cached", command: progressCommand, elapsedMs: 0 });
      return { name: check, passed: true, elapsedMs: 0, reason: reason || options.reason };
    }
  }

  throwIfAborted(signal);
  onProgress?.({ phase: "ci", check, state: "start", command: progressCommand });
  const started = Date.now();

  try {
    if (check === "format:check") {
      const { files: tracked, formatScoped: scoped } = await resolveFormatCheckFiles(cwd, {
        changedPaths,
        formatScoped,
      });
      // Scoped with zero prettier-able tracked paths → pass (nothing to check).
      // Unscoped empty list → fall through to package script (non-git fixtures).
      if (scoped || tracked.length > 0) {
        let checkedBlobs = false;
        try {
          if (tracked.length > 0) {
            await checkFormatFromBlobs(cwd, tracked, signal);
          }
          checkedBlobs = true;
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) throw abortError();
          // Real format failures still fail. Missing prettier (unit fixtures) uses the package script.
          if (!isPrettierUnresolved(err)) throw err;
        }
        if (checkedBlobs) {
          const elapsedMs = Date.now() - started;
          onProgress?.({ phase: "ci", check, state: "pass", command: progressCommand, elapsedMs });
          try {
            await recordCheckPass(cwd, check);
          } catch {
            // Check passed; cache write failed — ignore and continue without cache
          }
          const scopeNote = scoped
            ? `scoped ${tracked.length} changed file(s)`
            : `full tree ${tracked.length} file(s)`;
          return {
            name: check,
            passed: true,
            elapsedMs,
            reason: [reason || options.reason, scopeNote].filter(Boolean).join("; "),
          };
        }
      }
      // No tracked prettier files, not a git repo, or prettier is not installed in cwd.
    }

    await execAsync(shellCommand, { cwd, timeout, signal, maxBuffer: 2 * 1024 * 1024 });
    const elapsedMs = Date.now() - started;
    onProgress?.({ phase: "ci", check, state: "pass", command: progressCommand, elapsedMs });
    try {
      await recordCheckPass(cwd, check);
    } catch {
      // Check passed; cache write failed — ignore and continue without cache
    }
    return { name: check, passed: true, elapsedMs, reason: reason || options.reason };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw abortError();
    const output = collectExecOutput(err);
    const excerpt = formatFailureExcerpt(check, output);
    const logPath = await writeCiFailureLog(cwd, check, shellCommand, output, excerpt);
    const elapsedMs = Date.now() - started;
    const error = formatCiCheckError({ command: shellCommand, excerpt, logPath });
    const envFail = isCiEnvFailureOutput(output.firstLine);
    onProgress?.({
      phase: "ci",
      check,
      state: "fail",
      command: progressCommand,
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
      reason: reason || options.reason,
      kind: envFail ? "env" : "product",
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
 * RAD-92: junction/link primary node_modules into worktree before running checks.
 * RAD-117: confident package-/docs-scoped plans format only changed prettier paths (blobs).
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

  let toolchain: ToolchainEnsureResult | undefined;
  if (!options.skipToolchainEnsure) {
    toolchain = await ensureWorktreeCiToolchain(cwd, {
      primaryPath: options.toolchainPrimaryPath,
      allowInstall: options.allowToolchainInstall,
    });
    if (!toolchain.ok) {
      const error = formatToolchainSetupError(toolchain);
      onProgress?.({
        phase: "ci",
        check: "toolchain",
        state: "fail",
        message: toolchain.message,
        cwd,
      });
      return {
        allPassed: false,
        envUnhealthy: true,
        envMessage: toolchain.message,
        fixSteps: toolchain.fixSteps,
        toolchain,
        checks: [
          {
            name: "toolchain",
            passed: false,
            error,
            excerpt: toolchain.message,
            reason: "worktree CI toolchain setup",
            kind: "env",
          },
        ],
        selection,
        cwd,
      };
    }
  }

  if (selection) {
    onProgress?.({
      phase: "ci",
      state: "start",
      selectedChecks: selection.checks,
      selectionReason: formatCiSelectionReason(selection.reason),
      cwd,
    });
  } else {
    onProgress?.({
      phase: "ci",
      state: "start",
      selectedChecks: checks,
      selectionReason: options.changedPaths ? "caller-provided check list" : "configured suite",
      cwd,
    });
  }

  const results: CiCheckResult[] = [];
  const changedPaths = options.changedPaths ?? selection?.changedPaths;
  const packageScripts = options.packageScripts;

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
          changedPaths,
          packageScripts,
          selection,
        }).then((result) => {
          if (!result.passed && failFast) child.abort();
          return result;
        }),
      );
      const settled = await Promise.allSettled(pending);
      // Caller abort and fail-fast share the child controller. A caller abort
      // must reject; only a failed check should be recorded as a skip.
      if (signal?.aborted) throw abortError();
      for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        const check = checks[i];
        if (signal?.aborted) throw abortError();
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
            changedPaths,
            packageScripts,
            selection,
          }),
        );
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw abortError();
        throw err;
      }
    }
  }

  const envUnhealthy = results.some((r) => !r.passed && !r.skipped && r.kind === "env");
  const envFailed = results.find((r) => !r.passed && !r.skipped && r.kind === "env");
  return {
    allPassed: results.every((r) => r.passed),
    checks: results,
    selection,
    cwd,
    envUnhealthy: envUnhealthy || undefined,
    envMessage: envFailed?.excerpt ?? envFailed?.error,
    toolchain,
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
