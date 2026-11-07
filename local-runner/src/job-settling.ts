import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Cross-process guard while a job loop is unwinding (stop/archive races). */
export function settlingDir(dataDir: string): string {
  return path.join(dataDir, "settling");
}

function settlingFile(dataDir: string, jobId: string): string {
  return path.join(settlingDir(dataDir), `${jobId}.json`);
}

export type SettlingMarker = {
  jobId: string;
  pid: number;
  since: string;
};

export async function markJobSettling(dataDir: string, jobId: string): Promise<void> {
  const dir = settlingDir(dataDir);
  await mkdir(dir, { recursive: true });
  const marker: SettlingMarker = { jobId, pid: process.pid, since: new Date().toISOString() };
  await writeFile(settlingFile(dataDir, jobId), `${JSON.stringify(marker)}\n`, "utf8");
}

export async function clearJobSettling(dataDir: string, jobId: string): Promise<void> {
  await rm(settlingFile(dataDir, jobId), { force: true });
}

export async function readJobSettling(
  dataDir: string,
  jobId: string,
): Promise<SettlingMarker | null> {
  try {
    const raw = JSON.parse(await readFile(settlingFile(dataDir, jobId), "utf8")) as SettlingMarker;
    return raw?.jobId === jobId ? raw : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A marker whose owning process has exited (runner crash) is stale and removed. */
export async function isJobSettling(dataDir: string, jobId: string): Promise<boolean> {
  const marker = await readJobSettling(dataDir, jobId);
  if (!marker) return false;
  if (pidAlive(marker.pid)) return true;
  await clearJobSettling(dataDir, jobId);
  return false;
}

/**
 * Call once at engine start, before any job is scheduled: markers carrying this pid come from a
 * previous runner that reused it (e.g. pid 1 in a container), and dead-pid markers are crashes.
 */
export async function clearStaleSettlingMarkers(dataDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(settlingDir(dataDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const jobId = name.slice(0, -".json".length);
    const marker = await readJobSettling(dataDir, jobId);
    if (!marker || marker.pid === process.pid || !pidAlive(marker.pid)) {
      await clearJobSettling(dataDir, jobId);
    }
  }
}
