import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RunnerConfig {
  port: number;
  token: string;
  dataDir: string;
  notifyEmail: string | null;
  resendApiKey: string | null;
  defaultModel: string;
  dryRun: boolean;
}

const DEFAULT_PORT = 9473;

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".prgenie", "local-runner");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<RunnerConfig> {
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

  const token = env.PRGENIE_RUNNER_TOKEN?.trim();
  if (!token) {
    throw new Error("PRGENIE_RUNNER_TOKEN is required (shared bearer for localhost MCP + UI API).");
  }

  return {
    port: Number(env.PRGENIE_RUNNER_PORT || DEFAULT_PORT) || DEFAULT_PORT,
    token,
    dataDir,
    notifyEmail: env.PRGENIE_RUNNER_NOTIFY_EMAIL?.trim() || null,
    resendApiKey,
    defaultModel: env.PRGENIE_RUNNER_MODEL?.trim() || "composer-2.5",
    dryRun: env.PRGENIE_RUNNER_DRY_RUN === "1" || env.PRGENIE_RUNNER_DRY_RUN === "true",
  };
}
