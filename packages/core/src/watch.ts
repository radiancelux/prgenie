import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireGitRoot } from "./git.js";
import { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";

export type WatchHaltReason = "stop" | "export";

export interface RepoWatchState {
  halted: boolean;
  reason: WatchHaltReason | null;
  exportId: string | null;
  updatedAt: string;
}

function watchFile(dir: string): string {
  return path.join(dir, "watch.json");
}

const idle = (): RepoWatchState => ({
  halted: false,
  reason: null,
  exportId: null,
  updatedAt: new Date(0).toISOString(),
});

export async function getRepoWatch(cwd: string): Promise<RepoWatchState> {
  const root = await requireGitRoot(cwd);
  try {
    const raw = await readFile(watchFile(await consoleDir(root)), "utf8");
    const parsed = parseJsonObject<Partial<RepoWatchState>>(raw);
    return {
      halted: parsed.halted === true,
      reason: parsed.reason === "export" || parsed.reason === "stop" ? parsed.reason : null,
      exportId: parsed.exportId ?? null,
      updatedAt: parsed.updatedAt ?? idle().updatedAt,
    };
  } catch {
    return idle();
  }
}

export async function haltWatch(
  cwd: string,
  reason: WatchHaltReason,
  exportId: string | null = null,
): Promise<RepoWatchState> {
  const root = await requireGitRoot(cwd);
  const state: RepoWatchState = {
    halted: true,
    reason,
    exportId,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(watchFile(await consoleDir(root)), state);
  return state;
}

export async function resumeWatch(cwd: string): Promise<RepoWatchState> {
  const root = await requireGitRoot(cwd);
  const state: RepoWatchState = {
    halted: false,
    reason: null,
    exportId: null,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(watchFile(await consoleDir(root)), state);
  return state;
}
