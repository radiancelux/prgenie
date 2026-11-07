/** Built-in defaults and bounds for runner policy knobs (issues #119 / #121). */

export const BUILTIN_DEFAULT_MAX_ROUNDS = 3;
export const LEGACY_DEFAULT_MAX_ROUNDS = 2;

export const WATCHDOG_INACTIVITY_MS_DEFAULT = 15 * 60 * 1000;
export const WATCHDOG_STAGE_CAP_MS_DEFAULT = 120 * 60 * 1000;
export const WATCHDOG_RECOVERY_ATTEMPTS_DEFAULT = 1;
export const WATCHDOG_CHILD_GRACE_MS = 15_000;

export const WATCHDOG_INACTIVITY_MS_MIN = 60_000;
export const WATCHDOG_INACTIVITY_MS_MAX = 60 * 60 * 1000;
export const WATCHDOG_STAGE_CAP_MS_MIN = 5 * 60 * 1000;
export const WATCHDOG_STAGE_CAP_MS_MAX = 8 * 60 * 60 * 1000;
export const WATCHDOG_RECOVERY_ATTEMPTS_MIN = 0;
export const WATCHDOG_RECOVERY_ATTEMPTS_MAX = 3;

export const MAX_ACTIVE_JOBS_DEFAULT = 2;
export const MAX_ACTIVE_JOBS_MIN = 1;
export const MAX_ACTIVE_JOBS_MAX = 8;

export const MAX_ROUNDS_MIN = 1;
export const MAX_ROUNDS_MAX = 10;

export const JOB_ERROR_MAX_LEN = 2_000;

export const BUILTIN_FIX_MODEL = "auto";

export type WatchdogPolicy = {
  inactivityMs: number;
  stageCapMs: number;
  recoveryAttempts: number;
};

export const DEFAULT_WATCHDOG: WatchdogPolicy = {
  inactivityMs: WATCHDOG_INACTIVITY_MS_DEFAULT,
  stageCapMs: WATCHDOG_STAGE_CAP_MS_DEFAULT,
  recoveryAttempts: WATCHDOG_RECOVERY_ATTEMPTS_DEFAULT,
};

export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function parseBoundedMs(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return clampInt(raw, min, max);
}

export function parseWatchdogPolicy(raw: Partial<WatchdogPolicy> | undefined): WatchdogPolicy {
  return {
    inactivityMs: parseBoundedMs(
      raw?.inactivityMs,
      DEFAULT_WATCHDOG.inactivityMs,
      WATCHDOG_INACTIVITY_MS_MIN,
      WATCHDOG_INACTIVITY_MS_MAX,
    ),
    stageCapMs: parseBoundedMs(
      raw?.stageCapMs,
      DEFAULT_WATCHDOG.stageCapMs,
      WATCHDOG_STAGE_CAP_MS_MIN,
      WATCHDOG_STAGE_CAP_MS_MAX,
    ),
    recoveryAttempts: clampInt(
      typeof raw?.recoveryAttempts === "number"
        ? raw.recoveryAttempts
        : DEFAULT_WATCHDOG.recoveryAttempts,
      WATCHDOG_RECOVERY_ATTEMPTS_MIN,
      WATCHDOG_RECOVERY_ATTEMPTS_MAX,
    ),
  };
}
