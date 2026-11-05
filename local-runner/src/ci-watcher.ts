import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import type { JobRecord } from "./types.js";
import { fetchPrCiStatus, shouldPollCi } from "./ci.js";
import { archiveJobIfPrMerged } from "./job-merge.js";
import { resolveJobSpawnCwd } from "./job-cwd.js";
import { listJobs, loadJob, saveJob } from "./store.js";

const CI_POLL_MS = 45_000;

export class CiWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: RunnerConfig,
    private readonly engine: RunnerEngine,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), CI_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshJobById(jobId: string): Promise<void> {
    const job = await loadJob(this.config.dataDir, jobId);
    if (!job) return;
    await this.refreshJob(job);
  }

  private async refreshJob(job: JobRecord): Promise<void> {
    const cwd = resolveJobSpawnCwd(job);
    if (!cwd) return;
    const next = await fetchPrCiStatus(cwd, {
      prNumber: job.prNumber,
      branch: job.input.branch,
    });
    const prev = JSON.stringify(job.ciStatus);
    job.ciStatus = { ...next, checkedAt: new Date().toISOString() };
    if (JSON.stringify(job.ciStatus) !== prev) {
      await saveJob(this.config.dataDir, job);
      this.engine.emit("event", job.id, { type: "ci" });
    }
  }

  private async tick(): Promise<void> {
    const jobs = await listJobs(this.config.dataDir, { includeArchived: true });
    for (let job of jobs) {
      const { job: afterMerge, archived } = await archiveJobIfPrMerged(this.config.dataDir, job);
      job = afterMerge;
      if (archived) {
        this.engine.emit("event", job.id, { type: "ci" });
        continue;
      }
      if (!shouldPollCi(job)) continue;
      await this.refreshJob(job);
    }
  }
}
