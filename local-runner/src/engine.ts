import type { RunnerConfig } from "./config.js";
import { runJobLoop, jobSnapshot } from "./job-runner.js";
import {
  createJob,
  listJobs,
  loadJob,
  saveJob,
} from "./store.js";
import type { JobRecord } from "./types.js";
import type { JobEvent, StartJobArgs } from "./types.js";
import { EventEmitter } from "node:events";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

export class RunnerEngine extends EventEmitter {
  private running = new Map<string, Promise<void>>();

  constructor(readonly config: RunnerConfig) {
    super();
  }

  async init(): Promise<void> {
    const jobs = await listJobs(this.config.dataDir);
    for (const job of jobs) {
      if (ACTIVE_STAGES.has(job.stage) && !job.stopRequested) {
        this.schedule(job.id);
      }
    }
  }

  async startJob(args: StartJobArgs): Promise<JobRecord> {
    const job = await createJob(this.config.dataDir, args, {
      model: this.config.defaultModel,
      dryRun: this.config.dryRun,
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
    await runJobLoop(this.config, job, {
      onEvent: (id, event) => this.emit("event", id, event),
    });
  }

  async list(): Promise<JobRecord[]> {
    return listJobs(this.config.dataDir);
  }

  async get(jobId: string) {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return null;
    return jobSnapshot(this.config, job);
  }

  async steer(jobId: string, prompt: string): Promise<JobRecord | null> {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return null;
    job.steerQueue.push(prompt.trim());
    await saveJob(this.config.dataDir, job);
    return job;
  }

  async stop(jobId: string): Promise<JobRecord | null> {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return null;
    job.stopRequested = true;
    await saveJob(this.config.dataDir, job);
    return job;
  }
}

export type { JobEvent };
