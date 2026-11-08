import type { RunnerConfig } from "./config.js";
import { CiWatcher, type CiWatcherDeps } from "./ci-watcher.js";
import { runJobLoop, jobSnapshot } from "./job-runner.js";
import { JobControl } from "./job-control.js";
import {
  archiveJob,
  clearFailedJobs,
  restoreJob,
  type ArchiveJobResult,
  type ClearFailedResult,
  type RestoreJobResult,
} from "./job-archive.js";
import {
  createJob,
  jobsDashboardMeta,
  listJobs,
  listJobsForDisplay,
  loadArchivedJob,
  loadJob,
  resolveJobRepoSlug,
  saveJob,
} from "./store.js";
import type { JobRecord } from "./types.js";
import type { JobEvent, StartJobArgs } from "./types.js";
import { EventEmitter } from "node:events";
import { loadSettings } from "./settings.js";
import {
  BranchConflictError,
  decideJobStart,
  listJobsForQueue,
  runnableQueuedJobs,
} from "./job-queue.js";
import {
  clearJobSettling,
  clearStaleSettlingMarkers,
  isJobSettling,
  markJobSettling,
} from "./job-settling.js";
import { ContinueJobError, continueJobFromRaw } from "./job-continue.js";
import { normalizeStartJobArgs, ValidationError } from "./settings-validation.js";
import { resolveJobTarget } from "./job-target.js";
import { markJobInterrupted } from "./job-interrupted.js";
import { persistJobWorker, spawnDetachedJobWorker, touchJobWorker } from "./job-worker-spawn.js";
import { waitForWorkerExit, workerLooksAlive } from "./job-worker-monitor.js";
import { inspectRestartState } from "./runner-restart.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

function useDetachedJobWorkers(): boolean {
  if (process.env.PRGENIE_RUNNER_INLINE_JOBS === "1") return false;
  if (process.env.PRGENIE_RUNNER_DETACHED_JOBS === "1") return true;
  const role = process.env.PRGENIE_RUNNER_ROLE?.trim();
  return role === "serve";
}

export class RunnerEngine extends EventEmitter {
  private running = new Map<string, Promise<void>>();
  /** Serializes queue decisions so concurrent starts cannot both pass the branch/cap check. */
  private queueLock: Promise<unknown> = Promise.resolve();
  readonly ciWatcher: CiWatcher;
  /** Shared with in-flight runJobLoop — steer/stop must not reload and clobber the live JobRecord. */
  readonly jobControls = new Map<string, JobControl>();
  private readonly watchCi: boolean;

  constructor(
    readonly config: RunnerConfig,
    opts: { watchCi?: boolean; ciWatcherDeps?: CiWatcherDeps } = {},
  ) {
    super();
    this.watchCi = opts.watchCi ?? true;
    this.ciWatcher = new CiWatcher(config, this, opts.ciWatcherDeps);
  }

  private readonly queueOptions = { isRunning: (id: string) => this.isRunning(id) };

  private controlFor(job: JobRecord): JobControl {
    let control = this.jobControls.get(job.id);
    if (!control) {
      control = JobControl.fromPersisted(job);
      this.jobControls.set(job.id, control);
    }
    return control;
  }

  private withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queueLock.then(fn, fn);
    this.queueLock = next.catch(() => undefined);
    return next;
  }

  async init(): Promise<void> {
    await clearStaleSettlingMarkers(this.config.dataDir);
    const jobs = await listJobs(this.config.dataDir);
    for (const job of jobs) {
      if (!ACTIVE_STAGES.has(job.stage) || job.stopRequested || job.queueState?.queued) continue;
      if (workerLooksAlive(job.worker)) {
        this.scheduleWorkerWatch(job.id, job.worker!);
        continue;
      }
      if (job.worker && !workerLooksAlive(job.worker)) {
        await markJobInterrupted(this.config, job.id, "worker_exit");
        this.emitJobsChanged();
        continue;
      }
      this.schedule(job.id);
    }
    await this.drainQueue();
    if (this.watchCi) this.ciWatcher.start();
  }

  async startJob(args: StartJobArgs): Promise<JobRecord> {
    const normalized = normalizeStartJobArgs({ ...args });
    const job = await this.withQueueLock(async () => {
      const created = await this.createJobRecord(normalized);
      if (!created.queueState?.queued) this.schedule(created.id);
      return created;
    });
    this.emitJobsChanged();
    return job;
  }

  private async createJobRecord(args: StartJobArgs): Promise<JobRecord> {
    const settings = await loadSettings(this.config.dataDir);
    const target = resolveJobTarget(args, settings, this.config);
    if (!target.ok) throw new ValidationError(target.error);
    const repoSlug = await resolveJobRepoSlug(target);
    const jobs = await listJobsForQueue(this.config.dataDir);
    const decision = decideJobStart(
      jobs,
      args.branch,
      repoSlug,
      settings.maxActiveJobs,
      this.queueOptions,
    );
    if (decision.action === "reject") {
      throw new BranchConflictError(decision.reason);
    }
    const job = await createJob(this.config.dataDir, args, {
      model: this.config.defaultModel,
      dryRun: this.config.dryRun,
      config: this.config,
    });
    if (decision.action === "queue") {
      job.queueState = {
        queued: true,
        position: decision.position,
        since: new Date().toISOString(),
      };
      await saveJob(this.config.dataDir, job);
    }
    return job;
  }

  /** Start queued jobs until every free slot is used. */
  private async drainQueue(): Promise<void> {
    const started = await this.withQueueLock(async () => {
      const settings = await loadSettings(this.config.dataDir);
      const jobs = await listJobsForQueue(this.config.dataDir);
      const next = runnableQueuedJobs(jobs, settings.maxActiveJobs, this.queueOptions);
      for (const job of next) {
        job.queueState = undefined;
        await saveJob(this.config.dataDir, job);
        this.schedule(job.id);
      }
      return next.length;
    });
    if (started) this.emitJobsChanged();
  }

  /** List-level change (job added, archived, restored) for dashboards subscribed to /api/events. */
  emitJobsChanged(): void {
    this.emit("jobs");
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  schedule(jobId: string): void {
    if (this.running.has(jobId)) return;
    const p = (
      useDetachedJobWorkers() ? this.runOneDetached(jobId) : this.runOneInline(jobId)
    ).finally(() => {
      this.running.delete(jobId);
    });
    this.running.set(jobId, p);
  }

  private scheduleWorkerWatch(jobId: string, worker: NonNullable<JobRecord["worker"]>): void {
    if (this.running.has(jobId)) return;
    const p = this.watchDetachedWorker(jobId, worker).finally(() => {
      this.running.delete(jobId);
      void this.drainQueue();
    });
    this.running.set(jobId, p);
  }

  private async watchDetachedWorker(
    jobId: string,
    worker: NonNullable<JobRecord["worker"]>,
  ): Promise<void> {
    const outcome = await waitForWorkerExit(worker);
    if (outcome === "timeout") {
      await markJobInterrupted(this.config, jobId, "adoption_failed", "worker watchdog timeout");
      this.emitJobsChanged();
      return;
    }
    const job = await loadJob(this.config.dataDir, jobId);
    if (job && ACTIVE_STAGES.has(job.stage) && !job.stopRequested) {
      await markJobInterrupted(this.config, jobId, "worker_exit", "stage did not settle");
      this.emitJobsChanged();
    }
  }

  private async runOneDetached(jobId: string): Promise<void> {
    const loaded = await loadJob(this.config.dataDir, jobId);
    if (!loaded) return;
    if (workerLooksAlive(loaded.worker)) {
      this.scheduleWorkerWatch(jobId, loaded.worker!);
      return;
    }
    const { pid } = spawnDetachedJobWorker(this.config, jobId);
    const job = await touchJobWorker(this.config, jobId, pid);
    if (!job?.worker) return;
    const outcome = await waitForWorkerExit(job.worker);
    if (outcome === "timeout") {
      await markJobInterrupted(this.config, jobId, "adoption_failed");
      this.emitJobsChanged();
      return;
    }
    const finalJob = await loadJob(this.config.dataDir, jobId);
    if (finalJob && ACTIVE_STAGES.has(finalJob.stage) && !finalJob.stopRequested) {
      await markJobInterrupted(this.config, jobId, "worker_exit", "stage did not settle");
    }
    this.emitJobsChanged();
  }

  private async runOneInline(jobId: string): Promise<void> {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return;
    const control = this.controlFor(job);
    await markJobSettling(this.config.dataDir, jobId);
    try {
      await runJobLoop(this.config, job, control, {
        onEvent: (id, event) => this.emit("event", id, event),
        onPrLinked: (id) => {
          if (this.watchCi) void this.ciWatcher.refreshJobById(id);
        },
      });
    } finally {
      await clearJobSettling(this.config.dataDir, jobId);
      this.jobControls.delete(jobId);
      await persistJobWorker(this.config, job, null);
      await this.drainQueue();
    }
  }

  async prepareRestart(): Promise<Awaited<ReturnType<typeof inspectRestartState>>> {
    const preview = await inspectRestartState(this.config);
    for (const id of preview.interruptedJobIds) {
      await markJobInterrupted(this.config, id, "worker_exit");
    }
    if (preview.interruptedJobIds.length) this.emitJobsChanged();
    return preview;
  }

  async list(opts?: {
    includeFinished?: boolean;
    includeArchived?: boolean;
  }): Promise<JobRecord[]> {
    return listJobsForDisplay(this.config.dataDir, Date.now(), {
      includeFinished: opts?.includeFinished,
      includeArchived: opts?.includeArchived,
    });
  }

  async jobsMeta(): Promise<{ totalOnDisk: number; mergedHidden: number; archived: number }> {
    return jobsDashboardMeta(this.config.dataDir);
  }

  /** Live job, else archived job (read-only transcript). */
  async get(jobId: string) {
    const job =
      (await loadJob(this.config.dataDir, jobId)) ??
      (await loadArchivedJob(this.config.dataDir, jobId));
    if (!job) return null;
    return jobSnapshot(this.config, job);
  }

  async archive(jobId: string): Promise<ArchiveJobResult> {
    const result = await this.withQueueLock(() =>
      archiveJob(this.config, jobId, {
        isRunning: (id) => this.isRunning(id),
        isSettling: (id) => isJobSettling(this.config.dataDir, id),
        dataDir: this.config.dataDir,
        log: (msg) => console.warn(`[archive] ${msg}`),
      }),
    );
    if (result.ok) this.emitJobsChanged();
    return result;
  }

  async restore(jobId: string): Promise<RestoreJobResult> {
    const result = await restoreJob(this.config, jobId);
    if (result.ok) this.emitJobsChanged();
    return result;
  }

  async clearFailed(opts: { includeStuckStopped?: boolean } = {}): Promise<ClearFailedResult> {
    const result = await clearFailedJobs(this.config, {
      includeStuckStopped: opts.includeStuckStopped,
      isRunning: (id) => this.isRunning(id),
      isSettling: (id) => isJobSettling(this.config.dataDir, id),
      dataDir: this.config.dataDir,
      log: (msg) => console.warn(`[archive] ${msg}`),
    });
    if (result.archived.length) this.emitJobsChanged();
    return result;
  }

  async steer(jobId: string, prompt: string): Promise<JobRecord | null> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return loadJob(this.config.dataDir, jobId);
    }
    const control = this.jobControls.get(jobId);
    control?.pushSteer(trimmed);
    // Under the queue lock so a drain cannot dequeue between this load and save.
    return this.withQueueLock(async () => {
      const job = await loadJob(this.config.dataDir, jobId);
      if (!job) return null;
      if (control) {
        JobControl.syncSteerQueueForPersist(job, control);
      } else {
        job.steerQueue.push(trimmed);
      }
      await saveJob(this.config.dataDir, job);
      return job;
    });
  }

  async continueJob(raw: Record<string, unknown>): Promise<{
    ok: true;
    id: string;
    stage: string;
    maxRounds: number;
    reviewRound: number;
    worktree: "reused" | "recreated" | "none";
    queued: boolean;
  }> {
    const result = await this.withQueueLock(async () => {
      const prepared = await continueJobFromRaw(this.config, raw, {
        isRunning: (id) => this.isRunning(id),
      });
      if (!prepared.queued) {
        this.schedule(prepared.job.id);
      }
      return prepared;
    });
    this.emitJobsChanged();
    if (this.watchCi && result.job.prUrl) {
      void this.ciWatcher.refreshJobById(result.job.id);
    }
    return {
      ok: true,
      id: result.job.id,
      stage: result.job.stage,
      maxRounds: result.job.maxRounds,
      reviewRound: result.job.reviewRound,
      worktree: result.worktree,
      queued: result.queued,
    };
  }

  async stop(jobId: string): Promise<JobRecord | null> {
    const job = await this.withQueueLock(async () => {
      const loaded = await loadJob(this.config.dataDir, jobId);
      if (!loaded) return null;
      loaded.stopRequested = true;
      if (loaded.queueState?.queued && !this.isRunning(jobId)) {
        loaded.queueState = undefined;
        loaded.stage = "stopped";
      }
      await saveJob(this.config.dataDir, loaded);
      return loaded;
    });
    this.jobControls.get(jobId)?.requestStop();
    const worker = job?.worker;
    if (workerLooksAlive(worker) && worker) {
      try {
        process.kill(worker.pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
    if (job?.stage === "stopped") this.emitJobsChanged();
    return job;
  }
}

export type { JobEvent };
export { ContinueJobError };
