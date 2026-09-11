import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface CiCheckResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface CiRunnerResult {
  allPassed: boolean;
  checks: CiCheckResult[];
}

export interface CiRunnerOptions {
  /** Override the default CI checks */
  checks?: string[];
  /** Timeout per check in milliseconds. Default 300000 (5 minutes) */
  timeout?: number;
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
async function checkFormatFromBlobs(cwd: string, files: string[]): Promise<void> {
  const failures: string[] = [];

  for (const file of files) {
    try {
      // Use git show :file to get the index/blob version (LF-normalized)
      // Pipe to prettier --stdin-filepath to check formatting
      const command = `git show ":${file.replace(/"/g, '\\"')}" | pnpm exec prettier --stdin-filepath "${file.replace(/"/g, '\\"')}" --check`;
      await execAsync(command, { cwd });
    } catch {
      failures.push(file);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Prettier format check failed for ${failures.length} file(s): ${failures.slice(0, 5).join(", ")}${failures.length > 5 ? "..." : ""}`,
    );
  }
}

/**
 * Run local CI checks. Discovers checks from package.json/CI workflow.
 * For prgenie: format:check, lint, typecheck, test, build
 *
 * RAD-36: format:check runs over git-tracked files only (matching remote CI clean checkout).
 * Untracked junk in working tree does not fail CI.
 *
 * RAD-46: format:check checks git blob (LF-normalized) content, not CRLF working tree.
 * This ensures Windows autocrlf repos pass when blob content is properly formatted.
 */
export async function runCiChecks(
  cwd: string,
  options: CiRunnerOptions = {},
): Promise<CiRunnerResult> {
  // Default checks match CI workflow order (skip check-versions - version checks are not PR-blocking)
  const checks = options.checks ?? ["format:check", "lint", "typecheck", "test", "build"];
  // RAD-46: Raise default timeout from 60s to 5min - healthy test suite can exceed 215s
  const timeout = options.timeout ?? 300000;

  const results: CiCheckResult[] = [];

  for (const check of checks) {
    try {
      const command = `pnpm ${check}`;

      // RAD-36/RAD-46: format:check runs over tracked files only, checking git blob content
      if (check === "format:check") {
        const tracked = await getTrackedFiles(cwd);
        // Only override command if we have a git repo with tracked files
        if (tracked.length > 0) {
          // RAD-46: Check git blob content (LF-normalized) to match remote CI on Windows autocrlf
          await checkFormatFromBlobs(cwd, tracked);
          results.push({ name: check, passed: true });
          continue;
        }
        // If no tracked files (not a git repo or empty repo), fall back to default pnpm format:check
      }

      await execAsync(command, { cwd, timeout });
      results.push({ name: check, passed: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: check,
        passed: false,
        error: message.split("\n")[0] || `Check '${check}' failed`,
      });
    }
  }

  return {
    allPassed: results.every((r) => r.passed),
    checks: results,
  };
}
