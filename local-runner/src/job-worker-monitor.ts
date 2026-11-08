import type { RunnerConfig } from "./config.js";
import { liveWorkerLock, type WorkerLockRecord } from "./job-worker-lock.js";
import { processIdentityAlive } from "./pid-util.js";
import { DEFAULT_WATCHDOG, WATCHDOG_CHILD_GRACE_MS, parseWatchdogPolicy } from "./runner-policy.js";
import { loadJob } from "./store.js";
import type { JobRecord } from "./types.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

/** How often a worker rewrites `heartbeatAt` in its lock file. */
export const WORKER_HEARTBEAT_MS = 5_000;
/** Non-agent work between stages (rebase, gh calls, notify) on top of the stage watchdog cap. */
const STAGE_BUDGET_SLACK_MS = 5 * 60_000;
const DEFAULT_KILL_GRACE_MS = 15_000;

export type WorkerSuperviseOptions = {
  pollMs?: number;
  now?: () => number;
  /** SIGTERM → SIGKILL grace when the supervisor has to stop a hung worker. */
  killGraceMs?: number;
  /** Override the per-job heartbeat staleness threshold (tests). */
  heartbeatStaleMs?: number;
  /** Called once per poll with the fresh job record (event forwarding). */
  onTick?: (job: JobRecord) => void;
};

export type WorkerSuperviseOutcome =
  | { kind: "settled" }
  | { kind: "gone" }
  | { kind: "dead" }
  | { kind: "terminated"; reason: string };

export type WorkerBudget = { heartbeatStaleMs: number; stageBudgetMs: number };

/** Liveness thresholds derived from the job's own watchdog snapshot (not live Setup values). */
export function workerBudgetForJob(job: JobRecord): WorkerBudget {
  const snap = job.effectiveSnapshot;
  const policy = snap
    ? parseWatchdogPolicy({
        inactivityMs: snap.watchdogInactivityMs,
        stageCapMs: snap.watchdogStageCapMs,
        recoveryAttempts: snap.watchdogRecoveryAttempts,
      })
    : DEFAULT_WATCHDOG;
  const attempts = policy.recoveryAttempts + 1;
  return {
    heartbeatStaleMs: Math.max(policy.inactivityMs, 6 * WORKER_HEARTBEAT_MS),
    stageBudgetMs: attempts * (policy.stageCapMs + WATCHDOG_CHILD_GRACE_MS) + STAGE_BUDGET_SLACK_MS,
  };
}

function parseMs(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export type WorkerStall = { kind: "heartbeat" | "stage"; reason: string };

/** Why a live worker should be stopped, or null while it is healthy. */
export function workerStall(
  job: JobRecord,
  lock: WorkerLockRecord,
  nowMs: number,
  overrides: Pick<WorkerSuperviseOptions, "heartbeatStaleMs"> = {},
): WorkerStall | null {
  const budget = workerBudgetForJob(job);
  const staleMs = overrides.heartbeatStaleMs ?? budget.heartbeatStaleMs;
  const lastBeat = Math.max(parseMs(lock.heartbeatAt), parseMs(lock.startedAt));
  if (nowMs - lastBeat > staleMs) {
    const reason = `worker heartbeat stale for ${nowMs - lastBeat}ms (limit ${staleMs}ms)`;
    return { kind: "heartbeat", reason };
  }
  if (!ACTIVE_STAGES.has(job.stage)) return null;
  // A stage carried over from before this worker started (continue, restart) restarts its clock.
  const stageStart = Math.max(parseMs(job.watchdog?.stageStartedAt), parseMs(lock.startedAt));
  if (nowMs - stageStart > budget.stageBudgetMs) {
    const reason = `${job.stage} exceeded watchdog budget (${budget.stageBudgetMs}ms)`;
    return { kind: "stage", reason };
  }
  return null;
}

/**
 * Safe to signal: the start time pins the exact process, or (platforms without one) a recent
 * heartbeat shows the PID still belongs to the worker.
 */
export function workerSignalSafe(lock: WorkerLockRecord, nowMs = Date.now()): boolean {
  if (!processIdentityAlive(lock)) return false;
  if (lock.procStartTime) return true;
  return nowMs - parseMs(lock.heartbeatAt) <= 6 * WORKER_HEARTBEAT_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signal(lock: WorkerLockRecord, sig: NodeJS.Signals): void {
  if (!processIdentityAlive(lock)) return;
  // Detached workers lead their own process group; take agent children down with them.
  if (process.platform !== "win32") {
    try {
      process.kill(-lock.pid, sig);
      return;
    } catch {
      // not a group leader (or already gone): fall back to the pid
    }
  }
  try {
    process.kill(lock.pid, sig);
  } catch {
    // already exited
  }
}

async function waitDead(lock: WorkerLockRecord, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processIdentityAlive(lock)) return true;
    await sleep(Math.min(pollMs, 200));
  }
  return !processIdentityAlive(lock);
}

/** SIGTERM, then SIGKILL after `graceMs`; true once the exact process is confirmed gone. */
export async function terminateWorker(
  lock: WorkerLockRecord,
  graceMs = DEFAULT_KILL_GRACE_MS,
  pollMs = 200,
): Promise<boolean> {
  signal(lock, "SIGTERM");
  if (await waitDead(lock, graceMs, pollMs)) return true;
  signal(lock, "SIGKILL");
  return waitDead(lock, 5_000, pollMs);
}

/**
 * Watch a detached worker until it exits. Never gives up on a healthy worker: it only returns
 * once the process is confirmed dead, either on its own (`settled` / `dead`) or after this
 * supervisor stopped it for a stale heartbeat or blown stage budget (`terminated`).
 */
export async function superviseDetachedWorker(
  config: RunnerConfig,
  jobId: string,
  opts: WorkerSuperviseOptions = {},
): Promise<WorkerSuperviseOutcome> {
  const pollMs = opts.pollMs ?? 1_000;
  const now = opts.now ?? Date.now;
  for (;;) {
    const job = await loadJob(config.dataDir, jobId);
    if (!job) return { kind: "gone" };
    opts.onTick?.(job);
    const lock = liveWorkerLock(config.dataDir, jobId);
    if (!lock) return ACTIVE_STAGES.has(job.stage) ? { kind: "dead" } : { kind: "settled" };
    const stall = workerStall(job, lock, now(), opts);
    if (stall) {
      // Without a start time a silent PID may already belong to someone else: never signal it.
      if (stall.kind === "heartbeat" && !lock.procStartTime) return { kind: "dead" };
      if (await terminateWorker(lock, opts.killGraceMs, pollMs)) {
        return { kind: "terminated", reason: stall.reason };
      }
    }
    await sleep(pollMs);
  }
}

/** Poll until some live process holds the job lock, or `exited` settles first. */
export async function waitForWorkerClaim(
  dataDir: string,
  jobId: string,
  exited: Promise<unknown>,
  pollMs = 100,
): Promise<WorkerLockRecord | null> {
  let done = false;
  void exited.finally(() => {
    done = true;
  });
  for (;;) {
    const lock = liveWorkerLock(dataDir, jobId);
    if (lock) return lock;
    if (done) return liveWorkerLock(dataDir, jobId) ?? null;
    await sleep(pollMs);
  }
}
