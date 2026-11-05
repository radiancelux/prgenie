import type { JobRecord } from "./types.js";

/** Live control plane for an in-flight job (steer/stop). Never replace the loop's JobRecord from disk. */
export class JobControl {
  stopRequested = false;
  steerQueue: string[] = [];
  private killFn: (() => void) | null = null;
  readonly abort = new AbortController();

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  registerKill(fn: () => void): void {
    this.killFn = fn;
    if (this.stopRequested) {
      fn();
    }
  }

  requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.abort.abort();
    this.killFn?.();
  }

  pushSteer(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.steerQueue.push(trimmed);
  }

  drainSteer(): string {
    return this.steerQueue.splice(0).join("\n\n");
  }

  /** Pending steers live on JobControl during a run; copy to JobRecord before every persist. */
  static syncSteerQueueForPersist(job: JobRecord, control: JobControl): void {
    job.steerQueue = [...control.steerQueue];
  }

  static fromPersisted(job: JobRecord): JobControl {
    const control = new JobControl();
    control.steerQueue = [...job.steerQueue];
    if (job.stopRequested) {
      control.requestStop();
    }
    return control;
  }
}
