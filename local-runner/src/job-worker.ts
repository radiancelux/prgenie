import { appendFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { runJobLoop } from "./job-runner.js";
import { JobControl } from "./job-control.js";
import { loadJob } from "./store.js";
import { clearJobSettling, markJobSettling } from "./job-settling.js";
import type { JobRecord } from "./types.js";
import { claimJobWorker, releaseJobWorker, touchWorkerHeartbeat } from "./job-worker-lock.js";
import { WORKER_HEARTBEAT_MS } from "./job-worker-monitor.js";

const POLL_MS = 1_500;
const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

/** Exit codes: 0 done, 1 loop crashed, 2 job missing, 3 another live worker owns the job. */
export const JOB_WORKER_DUPLICATE_EXIT = 3;

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

function startControlPoller(dataDir: string, jobId: string, control: JobControl): () => void {
  const timer = setInterval(() => {
    void syncControlFromDisk(dataDir, jobId, control);
  }, POLL_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return () => clearInterval(timer);
}

function heartbeatMs(): number {
  const n = Number(process.env.PRGENIE_RUNNER_WORKER_HEARTBEAT_MS);
  return Number.isFinite(n) && n > 0 ? n : WORKER_HEARTBEAT_MS;
}

function startHeartbeat(
  dataDir: string,
  jobId: string,
  token: string,
  control: JobControl,
): () => void {
  const timer = setInterval(() => {
    try {
      // Ownership lost (lock taken over as stale): stop rather than run as a second worker.
      if (!touchWorkerHeartbeat(dataDir, jobId, token)) control.requestStop();
    } catch {
      // transient fs error; the next beat retries
    }
  }, heartbeatMs());
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return () => clearInterval(timer);
}

async function logLine(logPath: string, line: string): Promise<void> {
  await appendFile(logPath, `${line}\n`, "utf8").catch(() => undefined);
}

export async function runJobWorker(jobId: string): Promise<number> {
  const config = await loadConfig(process.env, { command: "job-worker" });
  const job = await loadJob(config.dataDir, jobId);
  if (!job) {
    console.error(`[job-worker] job not found: ${jobId}`);
    return 2;
  }
  const claim = await claimJobWorker(config.dataDir, jobId, {
    token: process.env.PRGENIE_RUNNER_WORKER_TOKEN,
  });
  if (!claim.ok) {
    console.error(
      `[job-worker] refusing duplicate worker for ${jobId} (pid ${claim.holder?.pid ?? "?"} owns it)`,
    );
    return JOB_WORKER_DUPLICATE_EXIT;
  }
  const { token } = claim.worker;

  const control = JobControl.fromPersisted(job);
  const stopPoll = startControlPoller(config.dataDir, jobId, control);
  const stopHeartbeat = startHeartbeat(config.dataDir, jobId, token, control);
  process.on("SIGTERM", () => control.requestStop());
  process.on("SIGINT", () => control.requestStop());

  let exitCode = 0;
  let settling = false;
  try {
    // Re-read under ownership: a previous owner may have finished the job before we claimed it.
    const live = await loadJob(config.dataDir, jobId);
    if (!live) return 2;
    if (!ACTIVE_STAGES.has(live.stage) || live.queueState?.queued) return 0;
    await logLine(live.logPath, `[job-worker] pid ${process.pid} claimed job (${live.stage})`);
    await markJobSettling(config.dataDir, jobId);
    settling = true;
    await runJobLoop(config, live, control);
  } catch (err) {
    console.error(`[job-worker] ${jobId}:`, err);
    exitCode = 1;
  } finally {
    stopPoll();
    stopHeartbeat();
    if (settling) await clearJobSettling(config.dataDir, jobId);
    await releaseJobWorker(config.dataDir, jobId, token);
  }
  return exitCode;
}
