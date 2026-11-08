import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  STDIO_PLACEHOLDER_TOKEN,
  defaultDataDir,
  loadConfig,
  resolveRunnerToken,
  runnerTokenFile,
} from "./config.js";
import { prgenieCmd, runningViaNpx } from "./cli-invocation.js";
import { binaryOnPath } from "./drivers/driver-types.js";

const execFileAsync = promisify(execFile);

export interface RunnerDoctorCheck {
  id: string;
  ok: boolean;
  summary: string;
  fix?: string;
  severity?: "warn";
}

export interface RunnerDoctorReport {
  checks: RunnerDoctorCheck[];
  ok: boolean;
}

export type GhExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type RunnerDoctorDeps = {
  execGh?: (args: string[]) => Promise<GhExecResult>;
  fetch?: typeof fetch;
  /** When true, include npm registry reachability (typical npx installs). */
  checkNpmRegistry?: boolean;
  checkAgentCli?: () => Promise<RunnerDoctorCheck>;
};

function nodeMajor(): number {
  const m = /^v(\d+)/.exec(process.version);
  return m ? Number(m[1]) : 0;
}

async function defaultExecGh(args: string[]): Promise<GhExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, { timeout: 15_000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const code = typeof e.code === "number" ? e.code : 1;
    if (/ENOENT/i.test(String(e.message ?? err))) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return { stdout, stderr, code };
  }
}

export function parseGhAuthStatus(result: GhExecResult): RunnerDoctorCheck {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code === 0 && /logged in to/i.test(text)) {
    return { id: "gh-auth", ok: true, summary: "gh is authenticated." };
  }
  if (/token in GH_TOKEN is invalid/i.test(text)) {
    return {
      id: "gh-auth",
      ok: false,
      summary: "GH_TOKEN is set but invalid for GitHub.",
      fix: "Fix or unset GH_TOKEN (it overrides stored gh auth). Or run `gh auth login` after unsetting it.",
    };
  }
  if (/token in GITHUB_TOKEN is invalid/i.test(text)) {
    return {
      id: "gh-auth",
      ok: false,
      summary: "GITHUB_TOKEN is set but invalid for GitHub.",
      fix: "Fix or unset GITHUB_TOKEN (it overrides stored gh auth). Or run `gh auth login` after unsetting it.",
    };
  }
  if (/not logged into any GitHub hosts/i.test(text)) {
    return {
      id: "gh-auth",
      ok: false,
      summary: "gh is installed but not logged in.",
      fix: "Run `gh auth login` for the GitHub account that owns your repos.",
    };
  }
  if (result.code !== 0) {
    const line = text.split("\n").find((l) => l.trim()) ?? "gh auth status failed.";
    return {
      id: "gh-auth",
      ok: false,
      summary: line.replace(/^fatal:\s*/i, "").trim() || "gh auth status failed.",
      fix: "Run `gh auth login`, then retry `prgenie doctor`.",
    };
  }
  return {
    id: "gh-auth",
    ok: false,
    summary: "gh is installed but not logged in.",
    fix: "Run `gh auth login` for the GitHub account that owns your repos.",
  };
}

async function checkGit(): Promise<RunnerDoctorCheck> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5_000 });
    return { id: "git", ok: true, summary: stdout.trim() };
  } catch {
    return {
      id: "git",
      ok: false,
      summary: "git is not available on PATH.",
      fix: "Install git and ensure `git --version` works in this shell.",
    };
  }
}

async function checkGh(
  execGh: (args: string[]) => Promise<GhExecResult>,
): Promise<RunnerDoctorCheck> {
  try {
    const result = await execGh(["auth", "status"]);
    return parseGhAuthStatus(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/i.test(msg)) {
      return {
        id: "gh-auth",
        ok: false,
        summary: "gh CLI is not on PATH.",
        fix: "Install GitHub CLI: https://cli.github.com/",
      };
    }
    return {
      id: "gh-auth",
      ok: false,
      summary: "gh auth status failed.",
      fix: "Run `gh auth login`, then retry `prgenie doctor`.",
    };
  }
}

async function checkAgentCli(): Promise<RunnerDoctorCheck> {
  const cursor = await binaryOnPath("cursor-agent");
  if (cursor) {
    return {
      id: "agent-cli",
      ok: true,
      summary: "cursor-agent is on PATH (default driver).",
    };
  }
  return {
    id: "agent-cli",
    ok: false,
    summary: "cursor-agent is not on PATH.",
    fix: "Install Cursor CLI (`cursor-agent`) or configure another driver in runner settings after serve is up.",
  };
}

async function checkDataDir(dataDir: string): Promise<RunnerDoctorCheck> {
  try {
    await access(dataDir);
    return { id: "runner-data-dir", ok: true, summary: `Data dir exists (${dataDir}).` };
  } catch {
    return {
      id: "runner-data-dir",
      ok: true,
      severity: "warn",
      summary: "Runner data directory is missing (stdio MCP creates it on first use).",
      fix: "Run `prgenie init` before `prgenie serve` (not required for stdio MCP).",
    };
  }
}

async function checkToken(env: NodeJS.ProcessEnv, dataDir: string): Promise<RunnerDoctorCheck> {
  const token = await resolveRunnerToken(env, dataDir);
  if (token && token !== STDIO_PLACEHOLDER_TOKEN) {
    const via = env.PRGENIE_RUNNER_TOKEN?.trim()
      ? "PRGENIE_RUNNER_TOKEN"
      : runnerTokenFile(dataDir);
    return {
      id: "runner-token",
      ok: true,
      summary: `Bearer token configured (${via}).`,
    };
  }
  return {
    id: "runner-token",
    ok: true,
    severity: "warn",
    summary: "No runner bearer token yet (fine for stdio MCP only).",
    fix: "Run `prgenie init` before `prgenie serve`; serve reads runner.token automatically (or set PRGENIE_RUNNER_TOKEN).",
  };
}

async function probeUrl(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { "User-Agent": "prgenie-doctor" },
      method: "HEAD",
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkConnectivity(
  fetchFn: typeof fetch,
  checkNpmRegistry: boolean,
): Promise<RunnerDoctorCheck> {
  const githubOk = await probeUrl(fetchFn, "https://api.github.com/", 5_000);
  const npmOk = checkNpmRegistry
    ? await probeUrl(fetchFn, "https://registry.npmjs.org/prgenie", 5_000)
    : true;
  if (githubOk && npmOk) {
    return {
      id: "network",
      ok: true,
      summary: checkNpmRegistry
        ? "GitHub API and npm registry are reachable."
        : "GitHub API is reachable.",
    };
  }
  const parts: string[] = [];
  if (!githubOk) parts.push("GitHub API");
  if (checkNpmRegistry && !npmOk) parts.push("npm registry");
  return {
    id: "network",
    ok: true,
    severity: "warn",
    summary: `${parts.join(" and ")} unreachable from this host (offline or firewall?).`,
    fix: "Check network connectivity; gh and npx installs need outbound HTTPS.",
  };
}

export async function runRunnerDoctor(
  env: NodeJS.ProcessEnv = process.env,
  deps: RunnerDoctorDeps = {},
): Promise<RunnerDoctorReport> {
  const checks: RunnerDoctorCheck[] = [];
  const major = nodeMajor();
  checks.push(
    major >= 22
      ? { id: "node-version", ok: true, summary: `Node ${process.version} (>= 22).` }
      : {
          id: "node-version",
          ok: false,
          summary: `Node ${process.version} is below 22.`,
          fix: "Upgrade Node.js to 22 or newer.",
        },
  );

  const fetchFn = deps.fetch ?? fetch;
  const checkNpmRegistry = deps.checkNpmRegistry ?? runningViaNpx(env);

  checks.push(await checkGit());
  checks.push(await checkGh(deps.execGh ?? defaultExecGh));
  checks.push(deps.checkAgentCli ? await deps.checkAgentCli() : await checkAgentCli());
  checks.push(await checkConnectivity(fetchFn, checkNpmRegistry));

  const dataDir = env.PRGENIE_RUNNER_DATA_DIR?.trim() || defaultDataDir();
  checks.push(await checkDataDir(dataDir));
  checks.push(await checkToken(env, dataDir));

  try {
    await loadConfig(env, { command: "mcp" });
    checks.push({
      id: "runner-config",
      ok: true,
      summary: "Runner config loads for stdio MCP.",
    });
  } catch (err) {
    checks.push({
      id: "runner-config",
      ok: false,
      summary: err instanceof Error ? err.message : String(err),
      fix: "Run `prgenie init` and fix env per message.",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { checks, ok };
}

function localizePrgenieFixes(fix: string, env: NodeJS.ProcessEnv): string {
  return fix.replace(/`prgenie ([^`]+)`/g, (_, sub: string) => `\`${prgenieCmd(sub, env)}\``);
}

export function formatRunnerDoctorReport(
  report: RunnerDoctorReport,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const lines: string[] = ["PR Genie runner doctor", ""];
  for (const c of report.checks) {
    const mark = c.ok ? (c.severity === "warn" ? "warn" : "ok") : "FAIL";
    lines.push(`[${mark}] ${c.id}: ${c.summary}`);
    if (c.fix) lines.push(`      fix: ${localizePrgenieFixes(c.fix, env)}`);
  }
  const hasFail = report.checks.some((c) => !c.ok);
  lines.push(
    "",
    hasFail
      ? "One or more checks failed."
      : "All required checks passed (see warnings above if any).",
  );
  return `${lines.join("\n")}\n`;
}

export async function readInitTokenHint(dataDir: string): Promise<string | null> {
  const file = runnerTokenFile(dataDir);
  try {
    const raw = (await readFile(file, "utf8")).trim();
    return raw || null;
  } catch {
    return null;
  }
}
