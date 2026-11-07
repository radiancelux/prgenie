import type { WatchdogPolicy } from "./runner-policy.js";
import { WATCHDOG_CHILD_GRACE_MS } from "./runner-policy.js";

export type WatchdogClock = () => number;

export type StageWatchdogOptions = {
  policy: WatchdogPolicy;
  now?: WatchdogClock;
  tickMs?: number;
  childGraceMs?: number;
  killChild: () => void;
  onStall?: (reason: string) => void;
};

/** True when a stream-json or agent log line indicates meaningful progress (not CI noise). */
export function isMeaningfulAgentLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("[dry-run]")) return true;
  if (t.startsWith("--- agent")) return true;
  if (t.includes("ToolCall") || t.includes('"type":"tool"')) return true;
  if (t.includes('"type":"assistant"') || t.includes('"role":"assistant"')) return true;
  if (t.startsWith("{") && t.includes('"subtype"')) return true;
  if (t.startsWith("[steer]")) return false;
  return t.length > 2 && !t.startsWith("---");
}

export type StageWatchdogResult<T> =
  | { ok: true; value: T; recoveryAttempts: number }
  | { ok: false; reason: string; recoveryAttempts: number };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type StageWatchdogMonitor = {
  onLine: (line: string) => void;
  awaitRun: <T>(run: Promise<T>) => Promise<{ value?: T; stallReason: string }>;
  stop: () => void;
};

export function startStageWatchdogMonitor(opts: StageWatchdogOptions): StageWatchdogMonitor {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 1_000;
  const stageStarted = now();
  let lastActivity = stageStarted;
  let stallReason = "";
  let running = true;

  const timer = setInterval(() => {
    if (!running) return;
    const t = now();
    if (t - stageStarted >= opts.policy.stageCapMs) {
      stallReason = `stage exceeded hard cap (${opts.policy.stageCapMs}ms)`;
      opts.killChild();
      return;
    }
    if (t - lastActivity >= opts.policy.inactivityMs) {
      stallReason = `no meaningful agent activity for ${opts.policy.inactivityMs}ms`;
      opts.killChild();
    }
  }, tickMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    onLine(line: string) {
      if (isMeaningfulAgentLine(line)) lastActivity = now();
    },
    async awaitRun<T>(run: Promise<T>) {
      try {
        const value = await run;
        return { value, stallReason };
      } catch (err) {
        if (stallReason) return { stallReason };
        throw err;
      } finally {
        running = false;
        clearInterval(timer);
      }
    },
    stop() {
      running = false;
      clearInterval(timer);
    },
  };
}

/**
 * Runs an agent stage with bounded recovery retries after watchdog stall.
 */
export async function runAgentWithWatchdog<T>(
  opts: StageWatchdogOptions,
  runOnce: (onLine: (line: string) => void) => Promise<T>,
): Promise<StageWatchdogResult<T>> {
  const childGraceMs = opts.childGraceMs ?? WATCHDOG_CHILD_GRACE_MS;
  let recoveryAttempts = 0;
  const maxRecovery = opts.policy.recoveryAttempts;

  while (true) {
    const monitor = startStageWatchdogMonitor(opts);
    const run = runOnce((line) => monitor.onLine(line));
    const { value, stallReason } = await monitor.awaitRun(run);
    if (stallReason) {
      opts.onStall?.(stallReason);
      if (recoveryAttempts < maxRecovery) {
        recoveryAttempts += 1;
        await sleep(childGraceMs);
        continue;
      }
      return { ok: false, reason: stallReason, recoveryAttempts };
    }
    return { ok: true, value: value as T, recoveryAttempts };
  }
}

/** Simpler inactivity tracker for tests (injectable clock). */
export class InactivityTracker {
  private last: number;
  constructor(
    private readonly clock: WatchdogClock,
    initial?: number,
  ) {
    this.last = initial ?? clock();
  }

  noteActivity(): void {
    this.last = this.clock();
  }

  noteLine(line: string): void {
    if (isMeaningfulAgentLine(line)) this.noteActivity();
  }

  silentForMs(): number {
    return this.clock() - this.last;
  }

  stageAgeMs(since: number): number {
    return this.clock() - since;
  }
}
