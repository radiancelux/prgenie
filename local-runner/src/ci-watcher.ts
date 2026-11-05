import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import type { JobRecord } from "./types.js";
import { fetchPrCiStatus, shouldPollCi } from "./ci.js";
import { syncDraftReadyForJob } from "./draft-pr.js";
import { resolveJobSpawnCwd } from "./job-cwd.js";
import { listJobs, loadJob, saveJob } from "./store.js";
import { maybeCleanupJobWorktree } from "./worktree-cleanup.js";

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
    try {
      const cwd = resolveJobSpawnCwd(job);
      const next = await fetchPrCiStatus(cwd, {
        prNumber: job.prNumber,
        branch: job.input.branch,
        repoSlug: job.repoSlug,
        prUrl: job.prUrl,
      });
      const prev = JSON.stringify(job.ciStatus);
      job.ciStatus = { ...next, checkedAt: new Date().toISOString() };
      let changed = JSON.stringify(job.ciStatus) !== prev;

      const draft = await syncDraftReadyForJob(job, cwd);
      if (draft.changed) {
        job = draft.job;
        changed = true;
      }

      if (changed) {
        await saveJob(this.config.dataDir, job);
        this.engine.emit("event", job.id, { type: "ci" });
      }

      await maybeCleanupJobWorktree(this.config, job, Date.now(), (msg) =>
        console.warn(`[ci-watcher] ${msg}`),
      );
    } catch {
      // Never crash serve on CI poll failures.
    }
  }

  private async tick(): Promise<void> {
    const jobs = await listJobs(this.config.dataDir);
    const nowMs = Date.now();
    for (const job of jobs) {
      if (shouldPollCi(job)) {
        await this.refreshJob(job);
      } else if (job.worktreePath) {
        await maybeCleanupJobWorktree(this.config, job, nowMs, (msg) =>
          console.warn(`[ci-watcher] ${msg}`),
        );
      }
    }
  }
}
