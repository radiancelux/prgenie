import type { RunnerConfig } from "./config.js";
import { CiWatcher } from "./ci-watcher.js";
import { runJobLoop, jobSnapshot } from "./job-runner.js";
import { JobControl } from "./job-control.js";
import { createJob, listJobs, listJobsForDisplay, loadJob, saveJob } from "./store.js";
import type { JobRecord } from "./types.js";
import type { JobEvent, StartJobArgs } from "./types.js";
import { EventEmitter } from "node:events";

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
      if (ACTIVE_STAGES.has(job.stage) && !job.stopRequested) {
        this.schedule(job.id);
      }
    }
    this.ciWatcher.start();
  }

  async startJob(args: StartJobArgs): Promise<JobRecord> {
    const job = await createJob(this.config.dataDir, args, {
      model: this.config.defaultModel,
      dryRun: this.config.dryRun,
      config: this.config,
    });
    this.schedule(job.id);
    return job;
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
    try {
      await runJobLoop(this.config, job, control, {
        onEvent: (id, event) => this.emit("event", id, event),
        onPrLinked: (id) => void this.ciWatcher.refreshJobById(id),
      });
    } finally {
      this.jobControls.delete(jobId);
    }
  }

  async list(): Promise<JobRecord[]> {
    return listJobsForDisplay(this.config.dataDir);
  }

  async get(jobId: string) {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return null;
    return jobSnapshot(this.config, job);
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
