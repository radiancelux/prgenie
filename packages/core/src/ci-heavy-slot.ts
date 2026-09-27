import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pidAlive } from "./ci-abort.js";
import { gitCommonDir } from "./git.js";
import { abortError, throwIfAborted } from "./progress.js";
import { sameFsPath } from "./worktrees.js";
import type { CiCheckSelection } from "./ci-select.js";

export const CI_HEAVY_SLOT_DEFAULT_CONCURRENCY = 2;
export const CI_HEAVY_SLOT_POLL_MS = 1000;
export const CI_HEAVY_SLOT_HEARTBEAT_MS = 10_000;
export const CI_HEAVY_SLOT_STALE_MS = 90_000;
export const CI_HEAVY_SLOT_MAX_WAIT_MS = 30 * 60 * 1000;

const WARNED_INVALID_CONCURRENCY = new Set<string>();

export interface HeavySlotRecord {
  token: string;
  pid: number;
  loopId: string | null;
  check: string;
  cwd: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface HeavySlotTiming {
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  maxWaitMs?: number;
  /** Min interval between waiting progress notices (default 15s). */
  noticeMs?: number;
}

export interface AcquireHeavySlotOptions {
  cwd: string;
  loopId?: string | null;
  check: string;
  concurrency?: number;
  signal?: AbortSignal;
  timing?: HeavySlotTiming;
  onWaiting?: (message: string) => void;
}

export type HeavySlotHandle = {
  release: () => void;
  waitedMs: number;
  slotDir: string;
};

export class HeavySlotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeavySlotUnavailableError";
  }
}

export class HeavySlotMaxWaitError extends Error {
  readonly waitedMs: number;
  readonly concurrency: number;
  constructor(check: string, waitedMs: number, concurrency: number) {
    super(
      `${check} not started — waited ${Math.round(waitedMs / 1000)}s for a heavy-test slot (N=${concurrency}, PRGENIE_CI_HEAVY_CONCURRENCY)`,
    );
    this.name = "HeavySlotMaxWaitError";
    this.waitedMs = waitedMs;
    this.concurrency = concurrency;
  }
}

export function heavyTestConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRGENIE_CI_HEAVY_CONCURRENCY;
  if (raw == null || raw.trim() === "") return CI_HEAVY_SLOT_DEFAULT_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    const key = raw;
    if (!WARNED_INVALID_CONCURRENCY.has(key)) {
      WARNED_INVALID_CONCURRENCY.add(key);
      process.stderr.write(
        `PRGENIE_CI_HEAVY_CONCURRENCY=${JSON.stringify(raw)} is invalid; using ${CI_HEAVY_SLOT_DEFAULT_CONCURRENCY}.\n`,
      );
    }
    return CI_HEAVY_SLOT_DEFAULT_CONCURRENCY;
  }
  return n;
}

/** True when the check is a package-glob or root test run (not file-scoped test:<pkg>). */
export function isHeavyTestRun(check: string, selection?: CiCheckSelection): boolean {
  if (check === "test") return true;
  if (!check.startsWith("test:")) return false;
  const files = selection?.testFiles?.[check];
  return !files || files.length === 0;
}

export async function ciHeavySlotDir(cwd: string): Promise<string> {
  const common = await gitCommonDir(cwd);
  const dir = path.join(common, "agent-console", "ci-heavy");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slotFilePath(slotDir: string, k: number): string {
  return path.join(slotDir, `slot-${k}.json`);
}

function readSlot(file: string): HeavySlotRecord | null {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as HeavySlotRecord;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function slotStale(file: string, record: HeavySlotRecord | null, staleMs: number): boolean {
  if (record) {
    if (!pidAlive(record.pid)) return true;
    const hb = Date.parse(record.heartbeatAt);
    if (Number.isFinite(hb) && Date.now() - hb > staleMs) return true;
    return false;
  }
  try {
    const mtime = statSync(file).mtimeMs;
    return Date.now() - mtime > staleMs;
  } catch {
    return true;
  }
}

function tryDeleteStaleSlot(file: string, staleMs: number): boolean {
  const first = readSlot(file);
  if (!slotStale(file, first, staleMs)) return false;
  const token = first?.token;
  const hb = first?.heartbeatAt;
  try {
    const again = readSlot(file);
    if (again?.token !== token || again?.heartbeatAt !== hb) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function listHeavySlotHolders(slotDir: string): HeavySlotRecord[] {
  const out: HeavySlotRecord[] = [];
  if (!existsSync(slotDir)) return out;
  try {
    for (const name of readdirSync(slotDir)) {
      if (!name.startsWith("slot-") || !name.endsWith(".json")) continue;
      const file = path.join(slotDir, name);
      const rec = readSlot(file);
      if (rec) out.push(rec);
    }
  } catch {
    // ignore
  }
  return out;
}

function formatHeldFor(record: HeavySlotRecord): string {
  const start = Date.parse(record.acquiredAt);
  if (!Number.isFinite(start)) return "?";
  const sec = Math.max(0, Math.round((Date.now() - start) / 1000));
  return `${sec}s`;
}

export function formatHeavySlotWaitMessage(
  held: HeavySlotRecord[],
  n: number,
  waitedSec: number,
): string {
  const holders = held
    .map((h) => {
      const who = h.loopId ?? `pid ${h.pid}`;
      return `${who} ${h.check} ${formatHeldFor(h)}`;
    })
    .join(", ");
  return `waiting for heavy-test slot (${held.length}/${n} busy: ${holders}) — waited ${waitedSec}s`;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function acquireHeavyTestSlot(
  options: AcquireHeavySlotOptions,
): Promise<HeavySlotHandle> {
  const timing = options.timing ?? {};
  const pollMs = timing.pollMs ?? CI_HEAVY_SLOT_POLL_MS;
  const heartbeatMs = timing.heartbeatMs ?? CI_HEAVY_SLOT_HEARTBEAT_MS;
  const staleMs = timing.staleMs ?? CI_HEAVY_SLOT_STALE_MS;
  const maxWaitMs = timing.maxWaitMs ?? CI_HEAVY_SLOT_MAX_WAIT_MS;
  const noticeMs = timing.noticeMs ?? 15_000;
  const n = options.concurrency ?? heavyTestConcurrency();
  const waitStart = Date.now();
  let lastNotice = 0;

  let slotDir: string;
  try {
    slotDir = await ciHeavySlotDir(options.cwd);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HeavySlotUnavailableError(detail);
  }

  const heldEnv = process.env.PRGENIE_CI_HEAVY_SLOT_HELD;
  if (heldEnv && sameFsPath(heldEnv, slotDir)) {
    return {
      waitedMs: 0,
      slotDir,
      release: () => undefined,
    };
  }

  const token = randomUUID();
  const record: HeavySlotRecord = {
    token,
    pid: process.pid,
    loopId: options.loopId ?? null,
    check: options.check,
    cwd: options.cwd,
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  for (;;) {
    throwIfAborted(options.signal);
    const waitedMs = Date.now() - waitStart;
    if (waitedMs >= maxWaitMs) {
      throw new HeavySlotMaxWaitError(options.check, waitedMs, n);
    }

    for (let k = 0; k < n; k++) {
      const file = slotFilePath(slotDir, k);
      if (existsSync(file)) {
        if (tryDeleteStaleSlot(file, staleMs)) continue;
        continue;
      }
      try {
        const fd = openSync(file, "wx");
        try {
          writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        } finally {
          closeSync(fd);
        }
        const heartbeatTimer = setInterval(() => {
          try {
            const cur = readSlot(file);
            if (!cur || cur.token !== token) return;
            cur.heartbeatAt = new Date().toISOString();
            writeFileSync(file, `${JSON.stringify(cur)}\n`, "utf8");
          } catch {
            // ignore
          }
        }, heartbeatMs);
        heartbeatTimer.unref?.();
        const release = (): void => {
          clearInterval(heartbeatTimer);
          try {
            const cur = readSlot(file);
            if (cur?.token === token) unlinkSync(file);
          } catch {
            // raced
          }
        };

        return { release, waitedMs, slotDir };
      } catch {
        // exclusive create lost — retry
      }
    }

    const held = listHeavySlotHolders(slotDir).filter((h) => pidAlive(h.pid));
    const waitedSec = Math.round(waitedMs / 1000);
    const now = Date.now();
    if (options.onWaiting && (lastNotice === 0 || now - lastNotice >= noticeMs)) {
      lastNotice = now;
      options.onWaiting(formatHeavySlotWaitMessage(held, n, waitedSec));
    }
    await sleepMs(pollMs, options.signal);
  }
}
