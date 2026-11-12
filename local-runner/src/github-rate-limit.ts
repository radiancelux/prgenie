import type { GhResult } from "./spawn-cmd.js";

export type GhFn = (cwd: string, args: string[]) => Promise<GhResult>;

export type SleepFn = (ms: number) => Promise<void>;

const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_INITIAL_BACKOFF_MS = 2_500;
const MAX_SINGLE_SLEEP_MS = 120_000;

const RATE_LIMIT_RE = /rate limit|ratelimit|secondary rate|abuse detection|403.*forbidden/i;

export function isGithubRateLimitError(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}

export function isGithubRateLimitResult(res: GhResult): boolean {
  if (res.code === 0) return false;
  const combined = `${res.stderr}\n${res.stdout}`;
  if (isGithubRateLimitError(combined)) return true;
  if (res.code === 403 && /forbidden/i.test(combined)) return true;
  return false;
}

/** Jittered backoff for attempt (0-based), capped per sleep. */
export function backoffDelayMs(
  attempt: number,
  resetAtEpochSec?: number | null,
  nowMs = Date.now(),
): number {
  if (resetAtEpochSec != null && Number.isFinite(resetAtEpochSec)) {
    const untilReset = resetAtEpochSec * 1000 - nowMs + 500;
    if (untilReset > 0) {
      const jitter = Math.floor(Math.random() * 1_500);
      return Math.min(MAX_SINGLE_SLEEP_MS, untilReset + jitter);
    }
  }
  const base = Math.min(
    MAX_SINGLE_SLEEP_MS,
    DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, Math.min(attempt, 8)),
  );
  const jitter = Math.floor(Math.random() * Math.min(5_000, base * 0.25));
  return Math.min(MAX_SINGLE_SLEEP_MS, base + jitter);
}

export type RateLimitResetLookup = (
  cwd: string,
  gh: GhFn,
) => Promise<{ core?: number; graphql?: number } | null>;

/** Best-effort read of GitHub rate_limit reset epochs (seconds). */
export async function fetchRateLimitResets(
  cwd: string,
  gh: GhFn,
): Promise<{ core?: number; graphql?: number } | null> {
  const res = await gh(cwd, ["api", "rate_limit"]);
  if (res.code !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as {
      resources?: { core?: { reset?: number }; graphql?: { reset?: number } };
    };
    return {
      core: parsed.resources?.core?.reset,
      graphql: parsed.resources?.graphql?.reset,
    };
  } catch {
    return null;
  }
}

export type GithubRetryOptions = {
  maxWaitMs?: number;
  sleep?: SleepFn;
  gh?: GhFn;
  lookupReset?: RateLimitResetLookup;
  /** When true, successful results still retry if rate-limited message appears in stdout (rare). */
};

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `gh` with retries on GitHub primary/secondary rate limits and 403 abuse throttling.
 */
export async function ghWithGithubRetry(
  cwd: string,
  args: string[],
  ghImpl: GhFn,
  options: GithubRetryOptions = {},
): Promise<GhResult> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const lookup = options.lookupReset ?? fetchRateLimitResets;
  const gh = options.gh ?? ghImpl;

  const started = Date.now();
  let attempt = 0;
  let last: GhResult = { code: 1, stdout: "", stderr: "" };

  while (Date.now() - started < maxWaitMs) {
    last = await ghImpl(cwd, args);
    if (!isGithubRateLimitResult(last)) return last;

    const resets = await lookup(cwd, gh);
    const resetAt = Math.max(resets?.core ?? 0, resets?.graphql ?? 0) || null;
    const delay = backoffDelayMs(attempt, resetAt);
    const remaining = maxWaitMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    attempt += 1;
  }

  return last;
}

export function isTransientGithubFailure(res: GhResult): boolean {
  return isGithubRateLimitResult(res);
}
