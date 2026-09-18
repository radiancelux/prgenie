import {
  isAbortError,
  needsExportGateEvaluation,
  type ExportGateSnapshot,
  type ProgressCallback,
  type ProgressEvent,
} from "@prgenie/core";

/**
 * Sidebar snapshot helpers for RCA Slice 0 (Windows dogfood stability).
 * The 2s poller / fs.watch path must never await full local CI.
 */

/** Cheap gates only — never format/lint/typecheck/test/build from the sidebar. */
export const SIDEBAR_SHEPHERD_OPTIONS = { skipCiCheck: true } as const;

/** Do not re-fetch cheap shepherd on every 2s poll. */
export const CHEAP_SHEPHERD_DEBOUNCE_MS = 30_000;

/**
 * Single-flight with trailing coalesce.
 * Concurrent callers share one in-flight run. Calls that arrive while work is
 * running collapse into exactly one follow-up (force flags OR together).
 */
export function createCoalescingFlight(
  run: (force: boolean) => Promise<void>,
): (force?: boolean) => Promise<void> {
  let current: Promise<void> | undefined;
  let queuedForce: boolean | undefined;
  let queuedWaiters: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

  const start = (force: boolean): Promise<void> => {
    current = (async () => {
      try {
        await run(force);
      } finally {
        const followForce = queuedForce;
        const waiters = queuedWaiters;
        queuedForce = undefined;
        queuedWaiters = [];
        current = undefined;
        if (followForce !== undefined) {
          const follow = start(followForce);
          follow.then(
            () => {
              for (const w of waiters) w.resolve();
            },
            (err) => {
              for (const w of waiters) w.reject(err);
            },
          );
        }
      }
    })();
    return current;
  };

  return function enqueue(force = false): Promise<void> {
    if (!current) return start(force);
    queuedForce = (queuedForce ?? false) || force;
    return new Promise((resolve, reject) => {
      queuedWaiters.push({ resolve, reject });
    });
  };
}

export type CheapShepherdScheduler = {
  schedule(root: string, id: string | undefined): void;
};

/**
 * Debounced, single-flight cheap shepherd fetch. Ignores stale results when
 * the selected loop changes mid-flight. Does not run full CI (caller must pass
 * a fetch that uses SIDEBAR_SHEPHERD_OPTIONS).
 */
export function createCheapShepherdScheduler<T>(opts: {
  fetch: (root: string, id: string) => Promise<T>;
  onResult: (id: string, result: T) => void;
  now?: () => number;
  debounceMs?: number;
  onError?: (err: unknown) => void;
}): CheapShepherdScheduler {
  const debounceMs = opts.debounceMs ?? CHEAP_SHEPHERD_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  let inFlight = false;
  let lastFetchedAt = 0;
  let lastFetchedId: string | undefined;
  let lastFetchedRoot: string | undefined;
  let wantedId: string | undefined;
  let wantedRoot: string | undefined;

  const pump = (): void => {
    if (inFlight) return;
    const id = wantedId;
    const root = wantedRoot;
    if (!id || !root) return;
    const sameTarget = lastFetchedId === id && lastFetchedRoot === root;
    if (sameTarget && now() - lastFetchedAt < debounceMs) return;

    inFlight = true;
    const fetchedId = id;
    const fetchedRoot = root;
    void opts
      .fetch(root, id)
      .then((result) => {
        if (wantedId !== fetchedId || wantedRoot !== fetchedRoot) return;
        lastFetchedAt = now();
        lastFetchedId = fetchedId;
        lastFetchedRoot = fetchedRoot;
        opts.onResult(fetchedId, result);
      })
      .catch((err) => {
        opts.onError?.(err);
      })
      .finally(() => {
        inFlight = false;
        pump();
      });
  };

  return {
    schedule(root: string, id: string | undefined) {
      wantedRoot = root;
      wantedId = id;
      if (!id) return;
      pump();
    },
  };
}

export type ExportGateCandidate = {
  id: string;
  status: string;
  headSha: string;
  exportGate?: ExportGateSnapshot | null;
};

export type ExportGateEvaluateCtx = {
  signal: AbortSignal;
  onProgress: ProgressCallback;
};

/**
 * One-shot full shepherd (includes CI) for reviewed loops that have no
 * current export-gate snapshot. Never called from the 2s snapshot await path.
 * Cancel skips auto-retry for that id+HEAD until retry() is called.
 */
export function createExportGateScheduler(opts: {
  evaluate: (root: string, id: string, ctx: ExportGateEvaluateCtx) => Promise<void>;
  onProgress?: (id: string, event: ProgressEvent) => void;
  onStart?: (id: string) => void;
  onDone?: (id: string) => void;
  onError?: (err: unknown, id: string) => void;
}): {
  schedule(root: string, pr: ExportGateCandidate | undefined): void;
  cancel(): boolean;
  retry(root: string, pr: ExportGateCandidate): void;
  inFlight(): boolean;
} {
  let inFlight = false;
  let wanted: { root: string; id: string; headSha: string } | undefined;
  let lastDone: string | undefined;
  let controller: AbortController | undefined;
  const skipped = new Set<string>();

  const keyOf = (item: { root: string; id: string; headSha: string }) =>
    `${item.root}:${item.id}:${item.headSha}`;

  const pump = (): void => {
    if (inFlight) return;
    const next = wanted;
    if (!next) return;
    const key = keyOf(next);
    if (lastDone === key || skipped.has(key)) return;
    inFlight = true;
    const started = next;
    const ac = new AbortController();
    controller = ac;
    opts.onStart?.(started.id);
    void opts
      .evaluate(started.root, started.id, {
        signal: ac.signal,
        onProgress: (event) => opts.onProgress?.(started.id, event),
      })
      .then(() => {
        lastDone = keyOf(started);
        opts.onDone?.(started.id);
      })
      .catch((err) => {
        if (isAbortError(err)) skipped.add(keyOf(started));
        opts.onError?.(err, started.id);
      })
      .finally(() => {
        if (controller === ac) controller = undefined;
        inFlight = false;
        if (
          wanted &&
          (wanted.id !== started.id ||
            wanted.headSha !== started.headSha ||
            wanted.root !== started.root)
        ) {
          pump();
        }
      });
  };

  return {
    schedule(root: string, pr: ExportGateCandidate | undefined) {
      if (!pr || !needsExportGateEvaluation(pr)) return;
      wanted = { root, id: pr.id, headSha: pr.headSha };
      pump();
    },
    cancel() {
      if (!controller) return false;
      controller.abort();
      return true;
    },
    retry(root: string, pr: ExportGateCandidate) {
      const key = `${root}:${pr.id}:${pr.headSha}`;
      skipped.delete(key);
      lastDone = undefined;
      wanted = { root, id: pr.id, headSha: pr.headSha };
      pump();
    },
    inFlight: () => inFlight,
  };
}
