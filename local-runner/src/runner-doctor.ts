import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { defaultDataDir, loadConfig, resolveRunnerToken, runnerTokenFile } from "./config.js";
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

function nodeMajor(): number {
  const m = /^v(\d+)/.exec(process.version);
  return m ? Number(m[1]) : 0;
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

async function checkGh(): Promise<RunnerDoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["auth", "status"], {
      timeout: 15_000,
    });
    const text = `${stdout}${stderr}`.trim();
    if (/logged in to/i.test(text)) {
      return { id: "gh-auth", ok: true, summary: "gh is authenticated." };
    }
    return {
      id: "gh-auth",
      ok: false,
      summary: "gh is installed but not logged in.",
      fix: "Run `gh auth login` for the GitHub account that owns your repos.",
    };
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
      ok: false,
      summary: "Runner data directory is missing.",
      fix: "Run `prgenie init` to create it.",
    };
  }
}

async function checkToken(env: NodeJS.ProcessEnv, dataDir: string): Promise<RunnerDoctorCheck> {
  const token = await resolveRunnerToken(env, dataDir);
  if (token) {
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
    fix: "Run `prgenie init`, then export PRGENIE_RUNNER_TOKEN for `prgenie serve`.",
  };
}

export async function runRunnerDoctor(
  env: NodeJS.ProcessEnv = process.env,
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

  checks.push(await checkGit());
  checks.push(await checkGh());
  checks.push(await checkAgentCli());

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

export function formatRunnerDoctorReport(report: RunnerDoctorReport): string {
  const lines: string[] = ["PR Genie runner doctor", ""];
  for (const c of report.checks) {
    const mark = c.ok ? (c.severity === "warn" ? "warn" : "ok") : "FAIL";
    lines.push(`[${mark}] ${c.id}: ${c.summary}`);
    if (c.fix) lines.push(`      fix: ${c.fix}`);
  }
  lines.push("", report.ok ? "All required checks passed." : "One or more checks failed.");
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
