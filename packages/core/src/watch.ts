import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireGitRoot } from "./git.js";
import { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";

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
  } catch {
    return idle();
  }
}

async function writeWatch(cwd: string, state: RepoWatchState): Promise<RepoWatchState> {
  const root = await requireGitRoot(cwd);
  await writeJsonFile(watchFile(await consoleDir(root)), state);
  return state;
}

export async function haltWatch(
  cwd: string,
  reason: WatchHaltReason,
  exportId: string | null = null,
): Promise<RepoWatchState> {
  const lane: WatchLaneState = { halted: true, reason, exportId };
  return writeWatch(cwd, derive(lane, { ...lane }, new Date().toISOString()));
}

export async function haltWatchRole(
  cwd: string,
  role: WatchRole,
  reason: WatchHaltReason = "stop",
): Promise<RepoWatchState> {
  const current = await getRepoWatch(cwd);
  const lane: WatchLaneState = { halted: true, reason, exportId: null };
  const inbox = role === "inbox" ? lane : current.inbox;
  const queue = role === "queue" ? lane : current.queue;
  return writeWatch(cwd, derive(inbox, queue, new Date().toISOString()));
}

export async function resumeWatch(cwd: string): Promise<RepoWatchState> {
  return writeWatch(cwd, derive(idleLane(), idleLane(), new Date().toISOString()));
}
