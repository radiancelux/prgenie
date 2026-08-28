import { appendFile } from "node:fs/promises";
import { findGitRoot } from "./git.js";
import { sessionsFile } from "./store.js";

export async function appendSession(
  cwd: string,
  event: Record<string, unknown>,
): Promise<void> {
  const root = await findGitRoot(cwd);
  if (!root) return;
  const file = await sessionsFile(root);
  const line = JSON.stringify({
    ...event,
    cwd,
    gitRoot: root,
    at: new Date().toISOString(),
  });
  await appendFile(file, `${line}\n`, "utf8");
}
