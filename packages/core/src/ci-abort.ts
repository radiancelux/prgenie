import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { abortError, throwIfAborted } from "./progress.js";

export interface CiAbortToken {
  id: string;
  seq: number;
  requestedAt: string;
}

export interface CiLockRecord {
  pid: number;
  id: string;
  headSha: string;
  startedAt: string;
}

const POLL_MS = 150;
const STALE_LOCK_MS = 30 * 60 * 1000;

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** Sync counterpart of gitCommonDir — cancel must write the token without awaiting. */
export function gitCommonDirSync(cwd: string): string {
  const dir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(cwd, dir);
}

export function ciAbortFile(cwd: string, id: string): string {
  return path.join(gitCommonDirSync(cwd), "agent-console", "ci-abort", `${safeId(id)}.json`);
}

export function ciLockFile(cwd: string, id: string, headSha: string): string {
  const short = headSha.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "head";
  return path.join(
    gitCommonDirSync(cwd),
    "agent-console",
    "ci-lock",
    `${safeId(id)}-${short}.json`,
  );
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readCiAbortSeq(cwd: string, id: string): number {
  const token = readJson<CiAbortToken>(ciAbortFile(cwd, id));
  return typeof token?.seq === "number" ? token.seq : 0;
}

/**
 * Bump the per-loop abort generation. In-flight MCP/CLI/panel CI that started
 * at an older seq abort. A later Retry / new run snapshots the new seq and proceeds.
 */
export function requestCiAbort(cwd: string, id: string): number {
  const file = ciAbortFile(cwd, id);
  mkdirSync(path.dirname(file), { recursive: true });
  const next = readCiAbortSeq(cwd, id) + 1;
  const token: CiAbortToken = {
    id,
    seq: next,
    requestedAt: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(token)}\n`, "utf8");
  return next;
}

/** Poll the abort token and abort `controller` when Cancel bumps the seq. */
export function watchCiAbort(cwd: string, id: string, controller: AbortController): () => void {
  const startSeq = readCiAbortSeq(cwd, id);
  const tick = (): void => {
    if (controller.signal.aborted) return;
    if (readCiAbortSeq(cwd, id) > startSeq) controller.abort();
  };
  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockStale(lock: CiLockRecord): boolean {
  if (!pidAlive(lock.pid)) return true;
  const started = Date.parse(lock.startedAt);
  return Number.isFinite(started) && Date.now() - started > STALE_LOCK_MS;
}

export type CiLockHandle = {
  /** True when a peer finished (or vanished) and this process should read the snapshot first. */
  peerDone: boolean;
  release: () => void;
};

/**
 * One export-gate / loop-CI suite per id+HEAD across processes (steward MCP + panel).
 * Waiters abort when the shared token bumps. Stale/dead locks are stolen.
 */
export async function acquireCiLock(
  cwd: string,
  id: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<CiLockHandle> {
  const file = ciLockFile(cwd, id, headSha);
  mkdirSync(path.dirname(file), { recursive: true });
  const record: CiLockRecord = {
    pid: process.pid,
    id,
    headSha,
    startedAt: new Date().toISOString(),
  };

  for (;;) {
    throwIfAborted(signal);
    const existing = existsSync(file) ? readJson<CiLockRecord>(file) : null;
    if (existing && !lockStale(existing)) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(abortError());
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, POLL_MS);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            reject(abortError());
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const still = existsSync(file) ? readJson<CiLockRecord>(file) : null;
      if (!still || lockStale(still) || still.pid !== existing.pid) {
        return { peerDone: true, release: () => undefined };
      }
      continue;
    }
    if (existing && lockStale(existing)) {
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
        peerDone: false,
        release: () => {
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
