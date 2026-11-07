import type { RunnerConfig } from "./config.js";
import { CiWatcher } from "./ci-watcher.js";
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
  saveJob,
} from "./store.js";
import type { JobRecord } from "./types.js";
import type { JobEvent, StartJobArgs } from "./types.js";
import { EventEmitter } from "node:events";
import { loadSettings } from "./settings.js";
import { countActiveJobs, decideJobStart, listJobsForQueue, nextQueuedJob } from "./job-queue.js";
import { clearJobSettling, markJobSettling } from "./job-settling.js";
import { normalizeStartJobArgs } from "./settings-validation.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export class RunnerEngine extends EventEmitter {
  private running = new Map<string, Promise<void>>();
  readonly ciWatcher: CiWatcher;
  /** Shared with in-flight runJobLoop — steer/stop must not reload and clobber the live JobRecord. */
  readonly jobControls = new Map<string, JobControl>();

  constructor(readonly config: RunnerConfig) {
    super();
    this.ciWatcher = new CiWatcher(config, this);
  }

  private controlFor(job: JobRecord): JobControl {
    let control = this.jobControls.get(job.id);
    if (!control) {
      control = JobControl.fromPersisted(job);
      this.jobControls.set(job.id, control);
    }
    return control;
  }

  async init(): Promise<void> {
    const jobs = await listJobs(this.config.dataDir);
    for (const job of jobs) {
      if (ACTIVE_STAGES.has(job.stage) && !job.stopRequested && !job.queueState?.queued) {
        this.schedule(job.id);
      }
    }
    await this.drainQueue();
    this.ciWatcher.start();
  }

  async startJob(args: StartJobArgs): Promise<JobRecord> {
    const job = await this.createJobRecord(normalizeStartJobArgs({ ...args }));
    if (!job.queueState?.queued) {
      this.schedule(job.id);
    }
    this.emitJobsChanged();
    return job;
  }

  private async createJobRecord(args: StartJobArgs): Promise<JobRecord> {
    const settings = await loadSettings(this.config.dataDir);
    const jobs = await listJobsForQueue(this.config.dataDir);
    const repoKey = args.repoPath?.trim() || args.remote?.trim() || "default";
    const decision = decideJobStart(jobs, args.branch, repoKey, settings.maxActiveJobs);
    if (decision.action === "reject") {
      throw new Error(decision.reason);
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

  private async drainQueue(): Promise<void> {
    const settings = await loadSettings(this.config.dataDir);
    const jobs = await listJobsForQueue(this.config.dataDir);
    if (countActiveJobs(jobs) >= settings.maxActiveJobs) return;
    const next = nextQueuedJob(jobs);
    if (!next) return;
    next.queueState = undefined;
    await saveJob(this.config.dataDir, next);
    this.schedule(next.id);
    this.emitJobsChanged();
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
    const p = this.runOne(jobId).finally(() => {
      this.running.delete(jobId);
    });
    this.running.set(jobId, p);
  }

  private async runOne(jobId: string): Promise<void> {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return;
    const control = this.controlFor(job);
    await markJobSettling(this.config.dataDir, jobId);
    try {
      await runJobLoop(this.config, job, control, {
        onEvent: (id, event) => this.emit("event", id, event),
        onPrLinked: (id) => void this.ciWatcher.refreshJobById(id),
      });
    } finally {
      await clearJobSettling(this.config.dataDir, jobId);
      this.jobControls.delete(jobId);
      await this.drainQueue();
    }
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
    const result = await archiveJob(this.config, jobId, {
      isRunning: (id) => this.isRunning(id),
      isSettling: async (id) =>
        (await import("./job-settling.js")).isJobSettling(this.config.dataDir, id),
      dataDir: this.config.dataDir,
      log: (msg) => console.warn(`[archive] ${msg}`),
    });
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
      isSettling: async (id) =>
        (await import("./job-settling.js")).isJobSettling(this.config.dataDir, id),
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
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return null;
    if (control) {
      JobControl.syncSteerQueueForPersist(job, control);
    } else {
      job.steerQueue.push(trimmed);
    }
    await saveJob(this.config.dataDir, job);
    return job;
  }

  async stop(jobId: string): Promise<JobRecord | null> {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return null;
    job.stopRequested = true;
    await saveJob(this.config.dataDir, job);
    this.jobControls.get(jobId)?.requestStop();
    return job;
  }
}

export type { JobEvent };
