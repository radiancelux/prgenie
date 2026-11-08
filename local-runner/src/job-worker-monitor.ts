import type { RunnerConfig } from "./config.js";
import { pidAlive, sameHost } from "./pid-util.js";
import { loadJob } from "./store.js";
import type { JobWorkerState } from "./types.js";

const POLL_MS = 400;

export function workerLooksAlive(worker: JobWorkerState | undefined): worker is JobWorkerState {
  if (!worker?.pid) return false;
  if (!sameHost(worker.hostname)) return false;
  return pidAlive(worker.pid);
}

/** Poll until the detached worker exits or the deadline passes. */
export function waitForWorkerExit(
  worker: JobWorkerState,
  deadlineMs = 120 * 60_000,
): Promise<"exited" | "timeout"> {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (!pidAlive(worker.pid)) {
        resolve("exited");
        return;
      }
      if (Date.now() > deadline) {
        resolve("timeout");
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

export async function readWorkerState(
  config: RunnerConfig,
  jobId: string,
): Promise<JobWorkerState | undefined> {
  const job = await loadJob(config.dataDir, jobId);
  return job?.worker;
}
