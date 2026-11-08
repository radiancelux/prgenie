import { DEFAULT_WATCHDOG, parseWatchdogPolicy, type WatchdogPolicy } from "./runner-policy.js";
import type { RunnerSettings } from "./settings.js";
import type { JobProfile, JobRecord } from "./types.js";
import { validateWatchdogPatch } from "./settings-validation.js";

/** Only compute jobs let busy child processes (not just agent output) reset inactivity. */
export function isComputeJob(job: Pick<JobRecord, "input">): boolean {
  return job.input.jobType === "compute" || job.input.profile === "compute";
}

/** Built-in watchdog defaults for `jobType: compute` (long CPU-bound tool runs). */
export const COMPUTE_JOB_DEFAULT_WATCHDOG: WatchdogPolicy = {
  inactivityMs: 60 * 60 * 1000,
  stageCapMs: 8 * 60 * 60 * 1000,
  recoveryAttempts: 0,
};

function jobTypeSettingsBag(
  settings: RunnerSettings,
  jobType: JobProfile,
): Record<string, unknown> | undefined {
  const bag = settings.jobTypes[jobType];
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return undefined;
  return bag as Record<string, unknown>;
}

function watchdogFromJobTypeBag(
  settings: RunnerSettings,
  jobType: JobProfile,
): WatchdogPolicy | undefined {
  const bag = jobTypeSettingsBag(settings, jobType);
  const raw = bag?.watchdog;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const base =
    jobType === "compute" ? COMPUTE_JOB_DEFAULT_WATCHDOG : (settings.watchdog ?? DEFAULT_WATCHDOG);
  return parseWatchdogPolicy({ ...base, ...(raw as Partial<WatchdogPolicy>) });
}

/** Global defaults for a profile before per-job overrides. */
export function baseWatchdogForJobType(
  jobType: JobProfile,
  settings: RunnerSettings,
): WatchdogPolicy {
  if (jobType === "compute") {
    const fromBag = watchdogFromJobTypeBag(settings, "compute");
    return fromBag ?? parseWatchdogPolicy(COMPUTE_JOB_DEFAULT_WATCHDOG);
  }
  if (jobType === "docs" || jobType === "code") {
    const fromBag = watchdogFromJobTypeBag(settings, jobType);
    if (fromBag) return fromBag;
  }
  return settings.watchdog ?? DEFAULT_WATCHDOG;
}

/** Frozen into `effectiveSnapshot` when a job is created. */
export function resolveJobWatchdogSnapshot(
  jobType: JobProfile,
  settings: RunnerSettings,
  requestOverride?: Partial<WatchdogPolicy>,
): WatchdogPolicy {
  const base = baseWatchdogForJobType(jobType, settings);
  if (!requestOverride || !Object.keys(requestOverride).length) return base;
  const patch = validateWatchdogPatch(requestOverride);
  return parseWatchdogPolicy({ ...base, ...patch });
}
