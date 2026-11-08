import { spawn, type ChildProcess } from "node:child_process";
import { childProcessSpawnOptions } from "./spawn-options.js";
import { randomUUID } from "node:crypto";
import type { RunnerConfig } from "./config.js";

function runnerArgvForJobWorker(jobId: string): { command: string; args: string[] } {
  const binary = process.env.PRGENIE_RUNNER_BINARY?.trim();
  const launcher = process.env.PRGENIE_RUNNER_WORKER_LAUNCHER?.trim();
  const nodeImport = process.env.PRGENIE_RUNNER_WORKER_NODE_IMPORT?.trim();
  if (binary && nodeImport) {
    return {
      command: process.execPath,
      args: [`--import=${nodeImport}`, binary, "job-worker", jobId],
    };
  }
  if (binary && launcher) {
    return { command: launcher, args: [binary, "job-worker", jobId] };
  }
  if (binary) {
    return { command: process.execPath, args: [binary, "job-worker", jobId] };
  }
  const bundled = process.argv[1];
  if (bundled) {
    return { command: process.execPath, args: [bundled, "job-worker", jobId] };
  }
  throw new Error("PRGENIE_RUNNER_BINARY or bundled argv[1] required to spawn job-worker");
}

function workerEnv(config: RunnerConfig, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PRGENIE_RUNNER_DATA_DIR: config.dataDir,
    PRGENIE_RUNNER_DRY_RUN: config.dryRun ? "1" : process.env.PRGENIE_RUNNER_DRY_RUN,
    PRGENIE_RUNNER_MODEL: config.defaultModel,
    PRGENIE_RUNNER_INLINE_JOBS: "1",
    PRGENIE_RUNNER_ROLE: "job-worker",
    PRGENIE_RUNNER_SLOW_MS: process.env.PRGENIE_RUNNER_SLOW_MS,
    PRGENIE_RUNNER_WORKER_TOKEN: token,
  };
}

export type SpawnedJobWorker = {
  child: ChildProcess;
  pid: number;
  /** Claim token the child will write into its lock. */
  token: string;
  /** Resolves with the exit code (null on signal or spawn error). */
  exited: Promise<number | null>;
};

/**
 * Launch `job-worker <id>` in its own session. The child claims the job lock itself; a losing
 * duplicate exits 3 without touching the job.
 */
export function spawnDetachedJobWorker(config: RunnerConfig, jobId: string): SpawnedJobWorker {
  const { command, args } = runnerArgvForJobWorker(jobId);
  const token = randomUUID();
  const child = spawn(
    command,
    args,
    childProcessSpawnOptions({
      detached: true,
      stdio: "ignore",
      env: workerEnv(config, token),
    }),
  );
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new Error(`failed to spawn job worker for ${jobId}`);
  }
  return { child, pid, token, exited };
}
