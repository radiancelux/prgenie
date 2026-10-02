import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
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

/** First complete `{...}` in a string, so leftover bytes after a short overwrite still parse. */
export function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonObject<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const slice = firstJsonObject(raw);
    if (!slice) throw new SyntaxError("No JSON object in file");
    return JSON.parse(slice) as T;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  const tmpHandle = await open(tmp, "w");
  try {
    await tmpHandle.writeFile(body, "utf8");
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  try {
    await rename(tmp, file);
    return;
  } catch {
    // Windows cannot rename over an existing file.
  }
  const dest = await open(file, "w");
  try {
    const buf = Buffer.from(body, "utf8");
    await dest.write(buf, 0, buf.length, 0);
    await dest.truncate(buf.length);
    await dest.sync();
  } finally {
    await dest.close();
  }
  await unlink(tmp).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockContention(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

async function tryStealStaleFileLock(lock: string): Promise<boolean> {
  let raw = "";
  let mtimeMs = Date.now();
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
  console.error(`[prgenie] stole stale file lock ${lock} (${holder})`);
  await unlink(lock).catch(() => undefined);
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
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".lock")) {
        out.push(full);
      }
    }
  }
  await walk(consoleDir);
  return out;
}

/** Cross-process lock so two reviewer chats cannot drop each other's comments. */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  let lastErr: unknown;
  // ~30s under Windows suite load: claim holders may stay inside fn() for seconds.
  for (let i = 0; i < 300; i++) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lock, "wx");
      const record: FileLockRecord = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      if (!isLockContention(err)) throw err;
      lastErr = err;
      if (await tryStealStaleFileLock(lock)) continue;
      await delay(100);
      continue;
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await unlink(lock).catch(() => undefined);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Timed out locking ${file}`);
}
