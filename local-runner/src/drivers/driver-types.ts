import { access } from "node:fs/promises";
import type { DriverEntry } from "../settings.js";

export interface AgentDriverRunOptions {
  cwd: string;
  prompt: string;
  model: string;
  logPath: string;
  dryRun?: boolean;
  outputFormat?: "stream-json" | "text";
  signal?: AbortSignal;
  driver: DriverEntry;
}

export interface AgentDriverRunResult {
  code: number;
  output: string;
}

export interface AgentDriverHandle {
  kill(): void;
}

export interface AgentDriver {
  readonly id: string;
  start(
    opts: AgentDriverRunOptions,
    hooks: {
      onLine: (line: string) => void;
      appendLog: (text: string) => Promise<void>;
    },
  ): Promise<{ result: Promise<AgentDriverRunResult>; handle: AgentDriverHandle }>;
  steer?(prompt: string, hooks: { appendLog: (text: string) => Promise<void> }): void;
}

export async function binaryOnPath(binary: string): Promise<boolean> {
  const name = binary.trim();
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) {
    try {
      await access(name);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    try {
      await access(`${dir}/${name}`);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}
