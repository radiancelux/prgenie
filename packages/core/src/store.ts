import { mkdir } from "node:fs/promises";
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
