import type { ExecFileOptions, SpawnOptions } from "node:child_process";

/** Shared spawn options so Windows jobs do not flash console windows (#197). */
export function childProcessSpawnOptions<T extends SpawnOptions | ExecFileOptions>(
  extra: T = {} as T,
): T & { windowsHide: boolean } {
  return { ...extra, windowsHide: true };
}
