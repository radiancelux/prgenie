import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { gitCommonDir } from "./git.js";

export async function consoleDir(cwd: string): Promise<string> {
  const common = await gitCommonDir(cwd);
  return path.join(common, "agent-console");
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
