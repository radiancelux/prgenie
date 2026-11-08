import type { WatchdogPolicy } from "./runner-policy.js";
import { WATCHDOG_CHILD_GRACE_MS } from "./runner-policy.js";

export type WatchdogClock = () => number;

export type StageWatchdogOptions = {
  policy: WatchdogPolicy;
  now?: WatchdogClock;
  tickMs?: number;
  /** How long a killed child may take to exit before the watchdog stops waiting for it. */
  childGraceMs?: number;
  killChild: () => void;
  onStall?: (reason: string) => void;
  /** Called once per retry, after the stalled child was killed and before it is re-run. */
  onRecovery?: (attempt: number, reason: string) => void;
  /** When true, refresh the inactivity clock (e.g. live child CPU under the agent). */
  pollActivity?: () => boolean;
  /** Fires whenever inactivity is refreshed (log line or pollActivity). */
  onActivity?: () => void;
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

export type StageWatchdogMonitor = {
  onLine: (line: string) => void;
  awaitRun: <T>(
    run: Promise<T>,
  ) => Promise<{ value?: T; stallReason: string; abandoned?: boolean }>;
  stop: () => void;
};

export function startStageWatchdogMonitor(opts: StageWatchdogOptions): StageWatchdogMonitor {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 1_000;
  const childGraceMs = opts.childGraceMs ?? WATCHDOG_CHILD_GRACE_MS;
  const stageStarted = now();
  let lastActivity = stageStarted;
  let stallReason = "";
  let killedAt: number | null = null;
  let running = true;
  let abandon: (() => void) | null = null;
  const abandoned = new Promise<void>((resolve) => {
    abandon = resolve;
  });

  const noteActivity = () => {
    lastActivity = now();
    opts.onActivity?.();
  };

  const timer = setInterval(() => {
    if (!running) return;
    const t = now();
    if (opts.pollActivity?.()) noteActivity();
    if (killedAt != null) {
      // The child ignored the kill (e.g. trapped SIGTERM): stop waiting so the cap is enforced.
      if (t - killedAt >= childGraceMs) abandon?.();
      return;
    }
    if (t - stageStarted >= opts.policy.stageCapMs) {
      stallReason = `stage exceeded hard cap (${opts.policy.stageCapMs}ms)`;
    } else if (t - lastActivity >= opts.policy.inactivityMs) {
      stallReason = `no meaningful agent activity for ${opts.policy.inactivityMs}ms`;
    } else {
      return;
    }
    killedAt = t;
    opts.killChild();
  }, tickMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    onLine(line: string) {
      if (isMeaningfulAgentLine(line)) noteActivity();
    },
    async awaitRun<T>(run: Promise<T>) {
      try {
        const settled = await Promise.race([
          run.then((value) => ({ value })),
          abandoned.then(() => null),
        ]);
        if (!settled) {
          run.catch(() => undefined);
          return { stallReason, abandoned: true };
        }
        return { value: settled.value, stallReason };
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
        opts.onRecovery?.(recoveryAttempts, stallReason);
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
