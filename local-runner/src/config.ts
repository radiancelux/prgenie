import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultRunnerHost } from "./listen-urls.js";

export type RunnerCommand =
  "serve" | "mcp" | "init" | "doctor" | "prune-worktrees" | "config" | "job-worker" | "restart";

export interface RunnerConfig {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  notifyEmail: string | null;
  resendApiKey: string | null;
  defaultModel: string;
  dryRun: boolean;
  /** Optional fallback local path for code jobs when setup has no code default preset. */
  defaultCodeRepoPath: string | null;
}

export const DEFAULT_PORT = 9473;

export function parseRunnerPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `PRGENIE_RUNNER_PORT must be a port number (1–65535), got ${JSON.stringify(raw)}.`,
    );
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65_535) {
    throw new Error(`PRGENIE_RUNNER_PORT must be between 1 and 65535, got ${port}.`);
  }
  return port;
}

/** Internal placeholder when stdio MCP runs without a bearer secret. */
export const STDIO_PLACEHOLDER_TOKEN = "stdio-local";

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".prgenie", "local-runner");
}

export function runnerTokenFile(dataDir: string): string {
  return path.join(dataDir, "runner.token");
}

export async function resolveRunnerToken(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): Promise<string | null> {
  const fromEnv = env.PRGENIE_RUNNER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = (await readFile(runnerTokenFile(dataDir), "utf8")).trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options?: { command?: RunnerCommand },
): Promise<RunnerConfig> {
  const dataDir = env.PRGENIE_RUNNER_DATA_DIR?.trim() || defaultDataDir();
  let resendApiKey = env.RESEND_API_KEY?.trim() || null;
  const secretFile = env.PRGENIE_RUNNER_RESEND_KEY_FILE?.trim();
  if (!resendApiKey && secretFile) {
    try {
      resendApiKey = (await readFile(secretFile, "utf8")).trim() || null;
    } catch {
      // optional
    }
  }

  const needsBearer = options?.command === "serve";
  let token = await resolveRunnerToken(env, dataDir);
  if (!token && needsBearer) {
    throw new Error(
      "PRGENIE_RUNNER_TOKEN is required for serve (HTTP dashboard + bearer MCP). Run `prgenie init`; serve reads runner.token automatically, or set PRGENIE_RUNNER_TOKEN.",
    );
  }
  if (!token) {
    token = STDIO_PLACEHOLDER_TOKEN;
  }

  return {
    host: env.PRGENIE_RUNNER_HOST?.trim() || defaultRunnerHost(),
    port: parseRunnerPort(env.PRGENIE_RUNNER_PORT),
    token,
    dataDir,
    notifyEmail: env.PRGENIE_RUNNER_NOTIFY_EMAIL?.trim() || null,
    resendApiKey,
    defaultModel: env.PRGENIE_RUNNER_MODEL?.trim() || "composer-2.5",
    dryRun: env.PRGENIE_RUNNER_DRY_RUN === "1" || env.PRGENIE_RUNNER_DRY_RUN === "true",
    defaultCodeRepoPath: env.PRGENIE_RUNNER_DEFAULT_REPO_PATH?.trim() || null,
  };
}
