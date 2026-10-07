import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileLockIsStale, parseFileLockRecord, type FileLockRecord } from "./ci-abort.js";
import { gitCommonDir } from "./git.js";

export async function consoleDir(cwd: string): Promise<string> {
  const common = await gitCommonDir(cwd);
  const dir = path.join(common, "agent-console");
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function prsDir(cwd: string): Promise<string> {
  const dir = path.join(await consoleDir(cwd), "prs");
  await mkdir(dir, { recursive: true });
  return dir;
}

export function prFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

export async function sessionsFile(cwd: string): Promise<string> {
  const dir = await consoleDir(cwd);
  await mkdir(dir, { recursive: true });
  return path.join(dir, "sessions.jsonl");
}

export function parseJsonObject<T>(raw: string, filePath?: string): T {
  const where = filePath ?? "JSON";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON at ${where}: ${detail}`, { cause: err });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON at ${where}: expected a JSON object`);
  }
  return parsed as T;
}

const RENAME_MAX_ATTEMPTS = 12;
const RENAME_BACKOFF_MS = 25;

export type WriteJsonFileTestHooks = {
  rename?: (from: string, to: string) => Promise<void>;
  randomSuffix?: () => string;
  delay?: (ms: number) => Promise<void>;
};

let writeJsonFileTestHooks: WriteJsonFileTestHooks | undefined;

/** Test seam for rename backoff and temp-path isolation (RAD-173). */
export function setWriteJsonFileTestHooks(hooks: WriteJsonFileTestHooks | undefined): void {
  writeJsonFileTestHooks = hooks;
}

function jsonTempPath(file: string): string {
  const suffix = writeJsonFileTestHooks?.randomSuffix?.() ?? randomBytes(8).toString("hex");
  return `${file}.${process.pid}.${suffix}.tmp`;
}

function isTransientRenameError(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = jsonTempPath(file);
  const tmpHandle = await open(tmp, "w");
  try {
    await tmpHandle.writeFile(body, "utf8");
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  const doRename = writeJsonFileTestHooks?.rename ?? rename;
  const doDelay = writeJsonFileTestHooks?.delay ?? delay;
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await doRename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err)) {
        throw new Error(
          `Failed to rename temp JSON ${tmp} onto ${file}: ${err instanceof Error ? err.message : String(err)} (temp kept for recovery)`,
          { cause: err },
        );
      }
      if (attempt < RENAME_MAX_ATTEMPTS - 1) {
        await doDelay(RENAME_BACKOFF_MS * (attempt + 1));
      }
    }
  }
  throw new Error(
    `Failed to rename temp JSON ${tmp} onto ${file} after ${RENAME_MAX_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} (temp kept for recovery)`,
    { cause: lastErr },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockContention(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

function lockRecordMatches(a: FileLockRecord, b: FileLockRecord): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.acquiredAt === b.acquiredAt;
}

async function readLockRecord(lock: string): Promise<FileLockRecord | null> {
  try {
    return parseFileLockRecord(await readFile(lock, "utf8"));
  } catch {
    return null;
  }
}

/** True when the lock path still contains this holder's metadata (not a replacement lock). */
async function lockStillHeldBy(lock: string, holder: FileLockRecord): Promise<boolean> {
  const onDisk = await readLockRecord(lock);
  return onDisk !== null && lockRecordMatches(onDisk, holder);
}

async function releaseFileLockIfOurs(lock: string, holder: FileLockRecord): Promise<void> {
  if (!(await lockStillHeldBy(lock, holder))) return;
  await unlink(lock).catch(() => undefined);
}

/**
 * Remove a stale lock only when rename proves the on-disk file is still the one we read.
 * If unlink of the renamed sidecar fails, restore the lock path and report not stolen.
 * Caller must already hold the critical section: on Windows a live holder can still be
 * inside fn while this rename succeeds, so rename is not admission.
 */
async function tryStealStaleFileLock(lock: string): Promise<boolean> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await readFile(lock, "utf8");
    mtimeMs = (await stat(lock)).mtimeMs;
  } catch {
    return false;
  }
  const record = parseFileLockRecord(raw);
  if (!fileLockIsStale(record, mtimeMs)) return false;
  const holder = record
    ? `pid=${record.pid} hostname=${record.hostname} acquiredAt=${record.acquiredAt}`
    : "legacy (no metadata)";
  const sidecar = `${lock}.${process.pid}.${Date.now()}.steal`;
  try {
    await rename(lock, sidecar);
  } catch {
    return false;
  }
  let sideRaw: string;
  try {
    sideRaw = await readFile(sidecar, "utf8");
  } catch {
    await rename(sidecar, lock).catch(() => undefined);
    return false;
  }
  if (sideRaw !== raw) {
    await rename(sidecar, lock).catch(() => undefined);
    return false;
  }
  try {
    await unlink(sidecar);
  } catch {
    await rename(sidecar, lock).catch(() => undefined);
    return false;
  }
  console.error(`[prgenie] stole stale file lock ${lock} (${holder})`);
  return true;
}

export function formatFileLockHolder(record: FileLockRecord | null, mtimeMs: number): string {
  if (!record) {
    return `legacy empty lock (mtime ${new Date(mtimeMs).toISOString()})`;
  }
  return `pid=${record.pid} hostname=${record.hostname} acquiredAt=${record.acquiredAt}`;
}

/** Recursively list `*.lock` files under agent-console (172-R3). */
export async function listAgentConsoleLockFiles(consoleDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && name.endsWith(".lock")) {
        out.push(full);
      }
    }
  }
  await walk(consoleDir);
  return out;
}

function sectionKey(lock: string): string {
  const resolved = path.resolve(lock);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Named pipe on Windows, abstract unix socket on Linux, pathname socket elsewhere.
 * The name stays busy until the listening fd closes or the holder process exits.
 * Linux abstract names are not directory entries, so release does not unlink a path
 * (a pathname unlink can drop a successor, and Linux reuses inodes immediately).
 */
function criticalSectionEndpoint(lock: string): string {
  const hash = createHash("sha256").update(sectionKey(lock)).digest("hex").slice(0, 40);
  if (process.platform === "win32") return `\\\\.\\pipe\\prgenie-flock-${hash}`;
  if (process.platform === "linux") return `\0prgenie-flock-${hash}`;
  return path.join(os.tmpdir(), `prgenie-flock-${hash}.sock`);
}

/** Pathname sockets leave a file behind. Abstract names and Windows pipes do not. */
function criticalSectionLeavesPath(name: string): boolean {
  return process.platform !== "win32" && !name.startsWith("\0");
}

/**
 * Admission gate for one lock path. On Windows, renaming or unlinking a lock that is
 * still open succeeds, so the lock file cannot prove the incumbent left fn.
 */
function listenCriticalSection(name: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    let settled = false;
    const finish = (result: Server | null, err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    };
    server.on("error", (err: NodeJS.ErrnoException) => {
      server.unref();
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        finish(null);
        return;
      }
      finish(null, err);
    });
    server.listen(name, () => finish(server));
  });
}

function endpointHeld(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(name);
    let settled = false;
    const done = (held: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(held);
    };
    const timer = setTimeout(() => done(true), 200);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function tryAcquireCriticalSection(lock: string): Promise<Server | null> {
  const name = criticalSectionEndpoint(lock);
  const first = await listenCriticalSection(name);
  if (first || !criticalSectionLeavesPath(name)) return first;
  // Stale pathname socket: the file outlived the listener. A live listener answers connect.
  if (await endpointHeld(name)) return null;
  await unlink(name).catch(() => undefined);
  return listenCriticalSection(name);
}

async function releaseCriticalSection(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function lockPresence(lock: string): Promise<{ present: boolean; stale: boolean }> {
  try {
    const raw = await readFile(lock, "utf8");
    const mtimeMs = (await stat(lock)).mtimeMs;
    return { present: true, stale: fileLockIsStale(parseFileLockRecord(raw), mtimeMs) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { present: false, stale: false };
    return { present: true, stale: false };
  }
}

type LockAttempt<T> =
  { status: "ok"; value: T } | { status: "retry"; wait: boolean; error?: unknown };

/**
 * One acquire attempt. The OS section is held through fn and released before this returns,
 * so a waiter cannot be admitted while this callback is still running.
 */
async function runFileLockAttempt<T>(file: string, fn: () => Promise<T>): Promise<LockAttempt<T>> {
  const lock = `${file}.lock`;
  const section = await tryAcquireCriticalSection(lock);
  if (!section) return { status: "retry", wait: true };
  try {
    const presence = await lockPresence(lock);
    if (presence.present && !presence.stale) {
      return { status: "retry", wait: true };
    }
    if (presence.present && presence.stale) {
      if (!(await tryStealStaleFileLock(lock))) {
        return { status: "retry", wait: true };
      }
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lock, "wx");
    } catch (err) {
      if (!isLockContention(err)) throw err;
      return { status: "retry", wait: true, error: err };
    }
    const myRecord: FileLockRecord = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    try {
      await handle.writeFile(`${JSON.stringify(myRecord)}\n`, "utf8");
      if (!(await lockStillHeldBy(lock, myRecord))) {
        return { status: "retry", wait: true };
      }
      const value = await fn();
      return { status: "ok", value };
    } finally {
      await handle.close().catch(() => undefined);
      await releaseFileLockIfOurs(lock, myRecord);
    }
  } finally {
    await releaseCriticalSection(section);
  }
}

/** Cross-process lock so two reviewer chats cannot drop each other's comments. */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  // ~30s under Windows suite load: claim holders may stay inside fn() for seconds.
  for (let i = 0; i < 300; i++) {
    const outcome = await runFileLockAttempt(file, fn);
    if (outcome.status === "ok") return outcome.value;
    lastErr = outcome.error ?? lastErr;
    if (outcome.wait) await delay(100);
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Timed out locking ${file}`);
}
