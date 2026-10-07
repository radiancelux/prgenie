import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { gitCommonDirSync } from "./ci-abort.js";
import { writeJsonFile } from "./store.js";

export interface LoopCancelMarker {
  id: string;
  cancelledAt: string | null;
  cancelledBy: string;
  source: string;
  implementorTaskId: string | null;
}

export type WriteLoopCancelFields = Omit<LoopCancelMarker, "id" | "cancelledAt"> & {
  cancelledAt?: string;
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function loopCancelFile(root: string, id: string): string {
  return path.join(gitCommonDirSync(root), "agent-console", "loop-cancel", `${safeId(id)}.json`);
}

export async function writeLoopCancel(
  root: string,
  id: string,
  fields: WriteLoopCancelFields,
): Promise<void> {
  const file = loopCancelFile(root, id);
  mkdirSync(path.dirname(file), { recursive: true });
  const marker: LoopCancelMarker = {
    id,
    cancelledAt: fields.cancelledAt ?? new Date().toISOString(),
    cancelledBy: fields.cancelledBy,
    source: fields.source,
    implementorTaskId: fields.implementorTaskId,
  };
  await writeJsonFile(file, marker);
}

export function readLoopCancel(root: string, id: string): LoopCancelMarker | null {
  const file = loopCancelFile(root, id);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<LoopCancelMarker>;
    return {
      id: typeof parsed.id === "string" ? parsed.id : id,
      cancelledAt: typeof parsed.cancelledAt === "string" ? parsed.cancelledAt : null,
      cancelledBy: typeof parsed.cancelledBy === "string" ? parsed.cancelledBy : "human",
      source: typeof parsed.source === "string" ? parsed.source : "panel",
      implementorTaskId:
        typeof parsed.implementorTaskId === "string"
          ? parsed.implementorTaskId
          : parsed.implementorTaskId === null
            ? null
            : null,
    };
  } catch {
    return {
      id,
      cancelledAt: null,
      cancelledBy: "human",
      source: "panel",
      implementorTaskId: null,
    };
  }
}

export function clearLoopCancel(root: string, id: string): void {
  const file = loopCancelFile(root, id);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // missing or raced — not an error
  }
}

export function assertLoopNotCancelled(root: string, id: string): void {
  const marker = readLoopCancel(root, id);
  if (!marker) return;
  const at = marker.cancelledAt ?? "unknown time";
  throw new Error(
    `Loop cancelled from panel at ${at}; clear to resume (panel "Resume loop" or MCP clear_loop_cancel).`,
  );
}
