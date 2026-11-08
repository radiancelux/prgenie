import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import type { JobRecord, JobWorkerState } from "./types.js";
import { saveJob, loadJob } from "./store.js";

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

function workerEnv(config: RunnerConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PRGENIE_RUNNER_DATA_DIR: config.dataDir,
    PRGENIE_RUNNER_DRY_RUN: config.dryRun ? "1" : process.env.PRGENIE_RUNNER_DRY_RUN,
    PRGENIE_RUNNER_MODEL: config.defaultModel,
    PRGENIE_RUNNER_INLINE_JOBS: "1",
    PRGENIE_RUNNER_ROLE: "job-worker",
    PRGENIE_RUNNER_SLOW_MS: process.env.PRGENIE_RUNNER_SLOW_MS,
  };
}

export function spawnDetachedJobWorker(
  config: RunnerConfig,
  jobId: string,
): { child: ChildProcess; pid: number } {
  const { command, args } = runnerArgvForJobWorker(jobId);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: workerEnv(config),
  });
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new Error(`failed to spawn job worker for ${jobId}`);
  }
  return { child, pid };
}

export async function persistJobWorker(
  config: RunnerConfig,
  job: JobRecord,
  worker: JobWorkerState | null,
): Promise<void> {
  job.worker = worker ?? undefined;
  await saveJob(config.dataDir, job);
}

export async function touchJobWorker(
  config: RunnerConfig,
  jobId: string,
  pid: number,
): Promise<JobRecord | null> {
  const job = await loadJob(config.dataDir, jobId);
  if (!job) return null;
  const worker: JobWorkerState = {
    pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  await persistJobWorker(config, job, worker);
  return job;
}
