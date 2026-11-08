import { loadConfig } from "./config.js";
import { runJobLoop } from "./job-runner.js";
import { JobControl } from "./job-control.js";
import { loadJob, saveJob } from "./store.js";
import { clearJobSettling, markJobSettling } from "./job-settling.js";
import type { JobRecord } from "./types.js";
import { pidAlive, sameHost } from "./pid-util.js";
import os from "node:os";

const POLL_MS = 1_500;

async function syncControlFromDisk(
  dataDir: string,
  jobId: string,
  control: JobControl,
): Promise<JobRecord | null> {
  const job = await loadJob(dataDir, jobId);
  if (!job) return null;
  for (const line of job.steerQueue) {
    if (!control.steerQueue.includes(line)) control.pushSteer(line);
  }
  if (job.stopRequested && !control.stopRequested) {
    control.requestStop();
  }
  return job;
}

function startControlPoller(
  dataDir: string,
  jobId: string,
  control: JobControl,
): () => void {
  const timer = setInterval(() => {
    void syncControlFromDisk(dataDir, jobId, control);
  }, POLL_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return () => clearInterval(timer);
}

async function clearWorkerField(dataDir: string, jobId: string): Promise<void> {
  const job = await loadJob(dataDir, jobId);
  if (!job?.worker) return;
  job.worker = undefined;
  await saveJob(dataDir, job);
}

export async function runJobWorker(jobId: string): Promise<number> {
  const config = await loadConfig(process.env, { command: "mcp" });
  const job = await loadJob(config.dataDir, jobId);
  if (!job) {
    console.error(`[job-worker] job not found: ${jobId}`);
    return 2;
  }
  job.worker = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  await saveJob(config.dataDir, job);

  const worker = job.worker;
  if (worker && sameHost(worker.hostname) && worker.pid !== process.pid && pidAlive(worker.pid)) {
    console.error(
      `[job-worker] refusing duplicate worker for ${jobId} (pid ${worker.pid} still running)`,
    );
    return 3;
  }

  const control = JobControl.fromPersisted(job);
  const stopPoll = startControlPoller(config.dataDir, jobId, control);

  process.on("SIGTERM", () => control.requestStop());
  process.on("SIGINT", () => control.requestStop());

  await markJobSettling(config.dataDir, jobId);
  let exitCode = 0;
  try {
    const live = await loadJob(config.dataDir, jobId);
    if (!live) return 2;
    live.worker = job.worker;
    await runJobLoop(config, live, control);
  } catch (err) {
    console.error(`[job-worker] ${jobId}:`, err);
    exitCode = 1;
  } finally {
    stopPoll();
    await clearJobSettling(config.dataDir, jobId);
    await clearWorkerField(config.dataDir, jobId);
  }
  return exitCode;
}
