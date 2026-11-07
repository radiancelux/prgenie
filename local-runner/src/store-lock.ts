import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const POLL_MS = 40;
const DEFAULT_MAX_WAIT_MS = 30_000;
const STALE_MS = 5 * 60 * 1000;

export interface StoreLockRecord {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLock(raw: string): StoreLockRecord | null {
  try {
    const p = JSON.parse(raw) as Partial<StoreLockRecord>;
    if (
      typeof p.pid === "number" &&
      typeof p.hostname === "string" &&
      typeof p.acquiredAt === "string"
    ) {
      return p as StoreLockRecord;
    }
  } catch {
    // legacy
  }
  return null;
}

function lockIsStale(record: StoreLockRecord | null, mtimeMs: number, now = Date.now()): boolean {
  if (!record) return now - mtimeMs > STALE_MS;
  const acquired = Date.parse(record.acquiredAt);
  const ageStale = Number.isFinite(acquired) && now - acquired > STALE_MS;
  if (record.hostname !== os.hostname()) return ageStale;
  if (!pidAlive(record.pid)) return true;
  return ageStale;
}

export function storeLockFile(dataDir: string): string {
  return path.join(dataDir, ".store.lock");
}

export type StoreLockHandle = { release: () => void };

/**
 * Serialize cross-process writers (stdio MCP + HTTP serve) against the shared job store.
 */
export async function acquireStoreLock(
  dataDir: string,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
): Promise<StoreLockHandle> {
  await mkdir(dataDir, { recursive: true });
  const file = storeLockFile(dataDir);
  const deadline = Date.now() + maxWaitMs;
  const record: StoreLockRecord = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for runner store lock (another serve/mcp process?)");
    }
    let existing: StoreLockRecord | null = null;
    let mtimeMs = 0;
    if (existsSync(file)) {
      try {
        existing = parseLock(readFileSync(file, "utf8"));
        const stat = await import("node:fs/promises").then((fs) => fs.stat(file));
        mtimeMs = stat.mtimeMs;
      } catch {
        existing = null;
      }
    }
    if (existing && !lockIsStale(existing, mtimeMs)) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    if (existing && lockIsStale(existing, mtimeMs)) {
      try {
        unlinkSync(file);
      } catch {
        // raced
      }
    }
    try {
      const fd = openSync(file, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

let inProcessStoreLock = false;

export async function withStoreLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
): Promise<T> {
  if (inProcessStoreLock) return fn();
  const handle = await acquireStoreLock(dataDir, maxWaitMs);
  inProcessStoreLock = true;
  try {
    return await fn();
  } finally {
    inProcessStoreLock = false;
    handle.release();
  }
}
