import { open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const RENAME_MAX_ATTEMPTS = 12;
const RENAME_BACKOFF_MS = 25;
const READ_MAX_ATTEMPTS = 8;
const READ_BACKOFF_MS = 15;

export type JsonFileTestHooks = {
  rename?: (from: string, to: string) => Promise<void>;
  randomSuffix?: () => string;
  delay?: (ms: number) => Promise<void>;
  readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
};

let jsonFileTestHooks: JsonFileTestHooks | undefined;

/** Test seam for rename backoff and temp-path isolation. */
export function setJsonFileTestHooks(hooks: JsonFileTestHooks | undefined): void {
  jsonFileTestHooks = hooks;
}

function jsonTempPath(file: string): string {
  const suffix = jsonFileTestHooks?.randomSuffix?.() ?? randomUUID();
  return `${file}.${process.pid}.${suffix}.tmp`;
}

function isTransientFsError(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const doDelay = () => jsonFileTestHooks?.delay ?? delay;

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
  const doRename = jsonFileTestHooks?.rename ?? rename;
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await doRename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientFsError(err)) {
        throw new Error(
          `Failed to rename temp JSON ${tmp} onto ${file}: ${err instanceof Error ? err.message : String(err)} (temp kept for recovery)`,
          { cause: err },
        );
      }
      if (attempt < RENAME_MAX_ATTEMPTS - 1) {
        await doDelay()(RENAME_BACKOFF_MS * (attempt + 1));
      }
    }
  }
  throw new Error(
    `Failed to rename temp JSON ${tmp} onto ${file} after ${RENAME_MAX_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} (temp kept for recovery)`,
    { cause: lastErr },
  );
}

function isTornJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

/** Read UTF-8 JSON text with short retries while another writer holds the file (Windows). */
export async function readUtf8WithRetry(filePath: string): Promise<string | null> {
  const readImpl = jsonFileTestHooks?.readFile ?? ((p, enc) => readFile(p, enc));
  let lastErr: unknown;
  for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      const raw = await readImpl(filePath, "utf8");
      if (isTornJson(raw)) {
        if (attempt < READ_MAX_ATTEMPTS - 1) {
          await doDelay()(READ_BACKOFF_MS * (attempt + 1));
          continue;
        }
        return null;
      }
      return raw;
    } catch (err) {
      lastErr = err;
      if (isTransientFsError(err) && attempt < READ_MAX_ATTEMPTS - 1) {
        await doDelay()(READ_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  void lastErr;
  return null;
}

const JOB_TMP_RE = /^[^/\\]+\.json\.\d+\.[^/\\]+\.tmp$/;

/** Remove stale `*.json.<pid>.<suffix>.tmp` files left after failed renames. */
export async function cleanupOrphanedJsonTemps(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  const maxAgeMs = 3_600_000;
  await Promise.all(
    names.map(async (name) => {
      if (!JOB_TMP_RE.test(name)) return;
      const full = path.join(dir, name);
      try {
        const st = await import("node:fs/promises").then((m) => m.stat(full));
        if (now - st.mtimeMs > maxAgeMs) await unlink(full);
      } catch {
        // ignore
      }
    }),
  );
}
