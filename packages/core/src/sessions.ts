import { appendFile, readFile } from "node:fs/promises";
import { findGitRoot } from "./git.js";
import { sessionsFile } from "./store.js";

export type SessionEvent = Record<string, unknown> & {
  at?: string;
  cwd?: string;
  gitRoot?: string;
  hook?: string;
};

export type ListSessionsOptions = {
  /** Max events (newest first). Default 50. Cap 1000. */
  limit?: number;
  /** Filter by exact hook name (e.g. subagentStop). */
  hook?: string;
  /** Inclusive ISO lower bound on event.at. */
  since?: string;
};

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

/**
 * Read session history from sessions.jsonl (newest first).
 * Corrupt / non-object lines are skipped.
 */
export async function listSessions(
  cwd: string,
  options: ListSessionsOptions = {},
): Promise<SessionEvent[]> {
  const root = await findGitRoot(cwd);
  if (!root) return [];
  const file = await sessionsFile(root);
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") return [];
    throw err;
  }

  const limitRaw = options.limit ?? 50;
  const limit = Math.min(
    1000,
    Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50),
  );
  const hook =
    typeof options.hook === "string" && options.hook ? options.hook : undefined;
  const sinceMs =
    typeof options.since === "string" && options.since
      ? Date.parse(options.since)
      : Number.NaN;

  const events: SessionEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed as SessionEvent;
    if (hook && event.hook !== hook) continue;
    if (Number.isFinite(sinceMs)) {
      const atMs = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
      if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    }
    events.push(event);
  }

  events.sort((a, b) => {
    const aMs = typeof a.at === "string" ? Date.parse(a.at) : 0;
    const bMs = typeof b.at === "string" ? Date.parse(b.at) : 0;
    return bMs - aMs;
  });

  return events.slice(0, limit);
}

export function formatSessionEvent(event: SessionEvent): string {
  const at = typeof event.at === "string" ? event.at : "?";
  const hook = typeof event.hook === "string" ? event.hook : "(no-hook)";
  const status = typeof event.status === "string" ? event.status : undefined;
  const task = typeof event.task === "string" ? event.task : undefined;
  const bits = [at, hook];
  if (status) bits.push(status);
  if (task) bits.push(task.length > 80 ? `${task.slice(0, 77)}...` : task);
  return bits.join("  ");
}
