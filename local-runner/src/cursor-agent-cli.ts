import { existsSync } from "node:fs";
import path from "node:path";

export const CURSOR_AGENT_POWERSHELL = "powershell.exe";
export const CURSOR_AGENT_CMD = process.env.ComSpec?.trim() || "cmd.exe";

export type ResolveCursorAgentBinaryOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  existsSync?: (filePath: string) => boolean;
  /** Logical command name (default `cursor-agent`). */
  name?: string;
};

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function win32CursorAgentNames(base: string): string[] {
  return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, `${base}.ps1`, base];
}

function findOnPath(
  names: string[],
  pathEnv: string,
  exists: (filePath: string) => boolean,
  delimiter: string,
): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** `%LOCALAPPDATA%\\cursor-agent\\` install layout from the Windows Cursor CLI. */
export function windowsCursorAgentFallbackCandidates(
  env: NodeJS.ProcessEnv = process.env,
  base = "cursor-agent",
): string[] {
  const local = env.LOCALAPPDATA?.trim() || env.LocalAppData?.trim();
  if (!local) return [];
  const dir = path.join(local, "cursor-agent");
  return [path.join(dir, `${base}.ps1`), path.join(dir, "agent.ps1")];
}

export function resolveCursorAgentBinary(
  options: ResolveCursorAgentBinaryOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? existsSync;
  const base = (options.name ?? "cursor-agent").trim();
  if (!base) return null;

  if (base.includes("/") || base.includes("\\")) {
    return exists(base) ? base : null;
  }

  const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
  const delimiter = pathDelimiter(platform);
  const names = platform === "win32" ? win32CursorAgentNames(base) : [base];

  const onPath = findOnPath(names, pathEnv, exists, delimiter);
  if (onPath) return onPath;

  if (platform === "win32" && (base === "cursor-agent" || base === "agent")) {
    const fallbackBase = base === "agent" ? "agent" : "cursor-agent";
    for (const candidate of windowsCursorAgentFallbackCandidates(env, fallbackBase)) {
      if (exists(candidate)) return candidate;
    }
  }

  return null;
}

export async function cursorAgentOnPath(
  options?: ResolveCursorAgentBinaryOptions,
): Promise<boolean> {
  return resolveCursorAgentBinary(options) !== null;
}

export type CursorAgentSpawnSpec = { command: string; args: string[] };

/** Build a `spawn()` argv; `.ps1` on Windows runs under PowerShell with a file path (no shell string). */
export function buildCursorAgentSpawn(
  resolvedBinary: string,
  cliArgs: string[],
  platform: NodeJS.Platform = process.platform,
): CursorAgentSpawnSpec {
  const ext = path.extname(resolvedBinary).toLowerCase();
  if (platform === "win32" && ext === ".ps1") {
    return {
      command: CURSOR_AGENT_POWERSHELL,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedBinary, ...cliArgs],
    };
  }
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    return { command: CURSOR_AGENT_CMD, args: ["/d", "/s", "/c", resolvedBinary, ...cliArgs] };
  }
  return { command: resolvedBinary, args: cliArgs };
}

export function formatCursorAgentInstallFix(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return (
      "Install Cursor CLI in PowerShell: `irm 'https://cursor.com/install?win32=true' | iex` " +
      "(requires Git for Windows with Git Bash — https://git-scm.com/download/win). " +
      "Open a new terminal, then run `cursor-agent login`. " +
      "Or configure another driver in runner settings after serve is up."
    );
  }
  return (
    "Install Cursor CLI: `curl https://cursor.com/install -fsS | bash`. " +
    "Open a new terminal, then run `cursor-agent login`. " +
    "Or configure another driver in runner settings after serve is up."
  );
}
