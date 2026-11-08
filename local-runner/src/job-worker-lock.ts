import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeJobId } from "./paths.js";
import { processIdentityAlive, readProcStartTime } from "./pid-util.js";
import { updateJobWorker } from "./store.js";
import { withStoreLock } from "./store-lock.js";
import type { JobWorkerState } from "./types.js";

/** On-disk ownership record: exactly one process may hold `workers/<jobId>.lock` at a time. */
export type WorkerLockRecord = JobWorkerState & { token: string; heartbeatAt: string };

export type ClaimResult =
  { ok: true; worker: WorkerLockRecord } | { ok: false; holder: WorkerLockRecord | null };

export function workersDir(dataDir: string): string {
  return path.join(dataDir, "workers");
}

export function workerLockFile(dataDir: string, jobId: string): string {
  if (!isSafeJobId(jobId)) throw new Error(`unsafe job id: ${jobId}`);
  return path.join(workersDir(dataDir), `${jobId}.lock`);
}

function parseLock(raw: string): WorkerLockRecord | null {
  try {
    const p = JSON.parse(raw) as Partial<WorkerLockRecord>;
    if (typeof p.pid === "number" && typeof p.token === "string") return p as WorkerLockRecord;
  } catch {
    // torn or foreign file
  }
  return null;
}

export function readWorkerLock(dataDir: string, jobId: string): WorkerLockRecord | null {
  try {
    return parseLock(readFileSync(workerLockFile(dataDir, jobId), "utf8"));
  } catch {
    return null;
  }
}

/** The lock holder, only when that exact process (PID + start time) is still running. */
export function liveWorkerLock(dataDir: string, jobId: string): WorkerLockRecord | null {
  const lock = readWorkerLock(dataDir, jobId);
  return lock && processIdentityAlive(lock) ? lock : null;
}

function tryCreateLock(file: string, record: WorkerLockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return true;
}

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Atomically claim job ownership for `pid` (default: this process). The fast path is an
 * `O_EXCL` create; replacing a dead holder's lock happens under the store lock with the
 * read-check-unlink-create done synchronously, so concurrent claimers in any process see a
 * single winner.
 */
export async function claimJobWorker(
  dataDir: string,
  jobId: string,
  opts: { token?: string; pid?: number } = {},
): Promise<ClaimResult> {
  const pid = opts.pid ?? process.pid;
  const now = new Date().toISOString();
  const record: WorkerLockRecord = {
    pid,
    hostname: os.hostname(),
    startedAt: now,
    heartbeatAt: now,
    token: opts.token?.trim() || randomUUID(),
    procStartTime: readProcStartTime(pid),
  };
  const file = workerLockFile(dataDir, jobId);
  mkdirSync(workersDir(dataDir), { recursive: true });

  if (!tryCreateLock(file, record)) {
    const lost = await withStoreLock(dataDir, async () => {
      const existing = readWorkerLock(dataDir, jobId);
      if (existing && processIdentityAlive(existing)) return { holder: existing };
      unlinkQuiet(file);
      if (tryCreateLock(file, record)) return null;
      return { holder: readWorkerLock(dataDir, jobId) };
    });
    if (lost) return { ok: false, holder: lost.holder };
  }
  const mirror: JobWorkerState = {
    pid: record.pid,
    hostname: record.hostname,
    startedAt: record.startedAt,
    token: record.token,
    procStartTime: record.procStartTime,
  };
  await updateJobWorker(dataDir, jobId, () => mirror);
  return { ok: true, worker: record };
}

/** Refresh `heartbeatAt` if `token` still owns the lock; false once ownership is lost. */
export function touchWorkerHeartbeat(dataDir: string, jobId: string, token: string): boolean {
  const lock = readWorkerLock(dataDir, jobId);
  if (!lock || lock.token !== token) return false;
  const file = workerLockFile(dataDir, jobId);
  const tmp = `${file}.${process.pid}.hb`;
  writeFileSync(tmp, `${JSON.stringify({ ...lock, heartbeatAt: new Date().toISOString() })}\n`);
  renameSync(tmp, file);
  return true;
}

/** Drop the lock and the job's `worker` mirror, but only while `token` still owns them. */
export async function releaseJobWorker(
  dataDir: string,
  jobId: string,
  token: string,
): Promise<void> {
  const lock = readWorkerLock(dataDir, jobId);
  if (lock?.token === token) unlinkQuiet(workerLockFile(dataDir, jobId));
  await updateJobWorker(dataDir, jobId, (current) =>
    current && (current.token === token || !current.token) ? null : undefined,
  );
}

/**
 * Forget a holder that is confirmed dead: removes a stale lock and clears the `worker` mirror
 * unless a live process has since claimed the job.
 */
export async function clearDeadWorker(dataDir: string, jobId: string): Promise<void> {
  await withStoreLock(dataDir, async () => {
    const lock = readWorkerLock(dataDir, jobId);
    if (lock && processIdentityAlive(lock)) return;
    if (lock) unlinkQuiet(workerLockFile(dataDir, jobId));
  });
  await updateJobWorker(dataDir, jobId, (current) => {
    if (!current) return undefined;
    const live = liveWorkerLock(dataDir, jobId);
    return live ? undefined : null;
  });
}
