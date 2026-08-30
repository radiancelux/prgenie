import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireGitRoot } from "./git.js";
import { consoleDir, parseJsonObject, withFileLock, writeJsonFile } from "./store.js";

export type WatchHaltReason = "stop" | "export";
export type WatchRole = "inbox" | "queue";

export interface WatchLaneState {
  halted: boolean;
  reason: WatchHaltReason | null;
  exportId: string | null;
}

export interface RepoWatchState {
  /** True when both inbox and queue are halted. */
  halted: boolean;
  reason: WatchHaltReason | null;
  exportId: string | null;
  inbox: WatchLaneState;
  queue: WatchLaneState;
  updatedAt: string;
}

function watchFile(dir: string): string {
  return path.join(dir, "watch.json");
}

const idleLane = (): WatchLaneState => ({
  halted: false,
  reason: null,
  exportId: null,
});

function derive(
  inbox: WatchLaneState,
  queue: WatchLaneState,
  updatedAt: string,
): RepoWatchState {
  const halted = inbox.halted && queue.halted;
  const reason = halted
    ? inbox.reason === queue.reason
      ? inbox.reason
      : (inbox.reason ?? queue.reason)
    : null;
  const exportId = inbox.exportId ?? queue.exportId;
  return { halted, reason, exportId, inbox, queue, updatedAt };
}

const idle = (): RepoWatchState =>
  derive(idleLane(), idleLane(), new Date(0).toISOString());

function parseLane(raw: unknown): WatchLaneState | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  return {
    halted: parsed.halted === true,
    reason: parsed.reason === "export" || parsed.reason === "stop" ? parsed.reason : null,
    exportId: typeof parsed.exportId === "string" ? parsed.exportId : null,
  };
}

function parseReason(value: unknown): WatchHaltReason | null {
  return value === "export" || value === "stop" ? value : null;
}

function parseWatchRaw(raw: string): RepoWatchState {
  const parsed = parseJsonObject<Record<string, unknown>>(raw);
  const updatedAt =
    typeof parsed.updatedAt === "string" ? parsed.updatedAt : idle().updatedAt;
  const inbox = parseLane(parsed.inbox);
  const queue = parseLane(parsed.queue);
  if (inbox && queue) return derive(inbox, queue, updatedAt);
  const legacy: WatchLaneState = {
    halted: parsed.halted === true,
    reason: parseReason(parsed.reason),
    exportId: typeof parsed.exportId === "string" ? parsed.exportId : null,
  };
  return derive(legacy, { ...legacy }, updatedAt);
}

export function watchLane(state: RepoWatchState, role: WatchRole): WatchLaneState {
  return state[role];
}

export function formatWatchLane(state: RepoWatchState, role: WatchRole): string {
  const lane = watchLane(state, role);
  if (!lane.halted) return "listening";
  return `halted  reason=${lane.reason ?? "stop"}${lane.exportId ? `  export=${lane.exportId}` : ""}`;
}

export function formatWatchStatus(state: RepoWatchState): string {
  return `inbox  ${formatWatchLane(state, "inbox")}\nqueue  ${formatWatchLane(state, "queue")}\n`;
}

export async function getRepoWatch(cwd: string): Promise<RepoWatchState> {
  const root = await requireGitRoot(cwd);
  try {
    const raw = await readFile(watchFile(await consoleDir(root)), "utf8");
    return parseWatchRaw(raw);
  } catch {
    return idle();
  }
}

async function mutateWatch(
  cwd: string,
  fn: (current: RepoWatchState) => RepoWatchState,
): Promise<RepoWatchState> {
  const root = await requireGitRoot(cwd);
  const file = watchFile(await consoleDir(root));
  return withFileLock(file, async () => {
    let current = idle();
    try {
      current = parseWatchRaw(await readFile(file, "utf8"));
    } catch {
      // Missing or unreadable watch.json → idle.
    }
    const next = fn(current);
    await writeJsonFile(file, next);
    return next;
  });
}

export async function haltWatch(
  cwd: string,
  reason: WatchHaltReason,
  exportId: string | null = null,
): Promise<RepoWatchState> {
  const lane: WatchLaneState = { halted: true, reason, exportId };
  return mutateWatch(cwd, () => derive(lane, { ...lane }, new Date().toISOString()));
}

export async function haltWatchRole(
  cwd: string,
  role: WatchRole,
  reason: WatchHaltReason = "stop",
): Promise<RepoWatchState> {
  const lane: WatchLaneState = { halted: true, reason, exportId: null };
  return mutateWatch(cwd, (current) => {
    const inbox = role === "inbox" ? lane : current.inbox;
    const queue = role === "queue" ? lane : current.queue;
    return derive(inbox, queue, new Date().toISOString());
  });
}

export async function resumeWatchRole(cwd: string, role: WatchRole): Promise<RepoWatchState> {
  return mutateWatch(cwd, (current) => {
    const inbox = role === "inbox" ? idleLane() : current.inbox;
    const queue = role === "queue" ? idleLane() : current.queue;
    return derive(inbox, queue, new Date().toISOString());
  });
}

export async function resumeWatch(cwd: string): Promise<RepoWatchState> {
  return mutateWatch(cwd, () => derive(idleLane(), idleLane(), new Date().toISOString()));
}

export interface WatchListenSentinel {
  tick: string;
  done: string;
  prompt: string;
  donePrompt: string;
}

export function listenSentinel(role: WatchRole): WatchListenSentinel {
  if (role === "inbox") {
    return {
      tick: "AGENT_LOOP_TICK_review-inbox",
      done: "AGENT_LOOP_DONE_review-inbox",
      prompt: "/review-inbox",
      donePrompt: "/stop-loop",
    };
  }
  return {
    tick: "AGENT_LOOP_TICK_review-queue",
    done: "AGENT_LOOP_DONE_review-queue",
    prompt: "/review-queue",
    donePrompt: "/stop-review",
  };
}

/** Parse durations like `30m`, `8h`, `45s`, `500ms`, or a bare number (minutes). */
export function parseDurationMs(raw: string, label = "duration"): number {
  const text = raw.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(text);
  if (!match) {
    throw new Error(`${label} must look like 30m, 8h, 45s, or a number of minutes`);
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  const unit = (match[2] ?? "m").toLowerCase();
  const mult =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "h" ? 3_600_000 : 60_000;
  return Math.round(n * mult);
}

export type ListenDoneReason = WatchHaltReason | "idle" | "max" | "ticks";

export async function listenWatchLane(
  cwd: string,
  role: WatchRole,
  options: {
    /** Max quiet period before DONE reason=idle. Default 30m. */
    idleMs?: number;
    /** Absolute wall-clock ceiling before DONE reason=max. Default 8h. */
    maxMs?: number;
    /** Optional hard tick ceiling (legacy --ticks). */
    ticks?: number;
    intervalMs?: number;
    write?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    activityFingerprint?: (cwd: string, role: WatchRole) => Promise<string>;
  } = {},
): Promise<"halted" | "done"> {
  const idleMs = options.idleMs ?? 30 * 60_000;
  const maxMs = options.maxMs ?? 8 * 60 * 60_000;
  const maxTicks = options.ticks;
  const intervalMs = options.intervalMs ?? 60_000;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const activity =
    options.activityFingerprint ??
    (async (dir: string, lane: WatchRole) => {
      const { listenActivityFingerprint } = await import("./watchActivity.js");
      return listenActivityFingerprint(dir, lane);
    });
  const sentinel = listenSentinel(role);
  const startedAt = now();
  let lastActivityAt = startedAt;
  let lastFingerprint = await activity(cwd, role);
  let tick = 0;

  const emitDone = (reason: ListenDoneReason): "halted" | "done" => {
    write(
      `${sentinel.done} ${JSON.stringify({
        prompt: sentinel.donePrompt,
        reason,
      })}`,
    );
    return reason === "stop" || reason === "export" ? "halted" : "done";
  };

  while (true) {
    const before = await getRepoWatch(cwd);
    if (before[role].halted) {
      return emitDone(before[role].reason ?? "stop");
    }

    const wall = now() - startedAt;
    if (wall >= maxMs) return emitDone("max");
    if (now() - lastActivityAt >= idleMs) return emitDone("idle");
    if (maxTicks !== undefined && tick >= maxTicks) return emitDone("ticks");

    await sleep(intervalMs);

    const after = await getRepoWatch(cwd);
    if (after[role].halted) {
      return emitDone(after[role].reason ?? "stop");
    }

    const fingerprint = await activity(cwd, role);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastActivityAt = now();
    }

    const afterWall = now() - startedAt;
    if (afterWall >= maxMs) return emitDone("max");
    if (now() - lastActivityAt >= idleMs) return emitDone("idle");

    tick += 1;
    if (maxTicks !== undefined && tick >= maxTicks) {
      write(`${sentinel.tick} ${JSON.stringify({ prompt: sentinel.prompt })}`);
      return emitDone("ticks");
    }
    write(`${sentinel.tick} ${JSON.stringify({ prompt: sentinel.prompt })}`);
  }
}
