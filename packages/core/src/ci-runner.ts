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
  /** Timeout per check in milliseconds. Default 60000 (60s) */
  timeout?: number;
}

/**
 * Run local CI checks. Discovers checks from package.json/CI workflow.
 * For prgenie: format:check, lint, typecheck, test, build
 */
export async function runCiChecks(
  cwd: string,
  options: CiRunnerOptions = {},
): Promise<CiRunnerResult> {
  // Default checks match CI workflow order (skip check-versions - version checks are not PR-blocking)
  const checks = options.checks ?? ["format:check", "lint", "typecheck", "test", "build"];
  const timeout = options.timeout ?? 60000;

  const results: CiCheckResult[] = [];

  for (const check of checks) {
    try {
      await execAsync(`pnpm ${check}`, { cwd, timeout });
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
