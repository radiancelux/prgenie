import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

export async function isJobSettling(dataDir: string, jobId: string): Promise<boolean> {
  return (await readJobSettling(dataDir, jobId)) != null;
}
