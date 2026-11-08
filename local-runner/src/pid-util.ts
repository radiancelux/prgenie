import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

/** True when `kill(pid, 0)` succeeds or the pid exists but is owned by another user (EPERM). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sameHost(hostname: string | undefined): boolean {
  if (!hostname?.trim()) return true;
  return hostname === os.hostname();
}

type ProcStat = { state: string; startTime: string };

function readLinuxProcStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` (field 2) may contain spaces or parens; fields after the last `)` are fixed.
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const state = rest[0];
    const startTime = rest[19];
    return state && startTime ? { state, startTime } : null;
  } catch {
    return null;
  }
}

/**
 * Stable per-process start marker, so a recycled PID is not mistaken for the original process.
 * `null` when the platform offers no cheap way to read it (identity then falls back to PID).
 */
export function readProcStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxProcStat(pid)?.startTime ?? null;
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Zombies still answer `kill(pid, 0)`; they are dead for every purpose the runner cares about. */
function isZombie(pid: number): boolean {
  if (process.platform !== "linux") return false;
  return readLinuxProcStat(pid)?.state === "Z";
}

export type ProcessIdentity = {
  pid: number;
  hostname?: string;
  procStartTime?: string | null;
};

/** True only when `pid` is alive on this host and (when recorded) still has the same start time. */
export function processIdentityAlive(identity: ProcessIdentity): boolean {
  if (!sameHost(identity.hostname)) return false;
  if (!pidAlive(identity.pid) || isZombie(identity.pid)) return false;
  if (!identity.procStartTime) return true;
  const current = readProcStartTime(identity.pid);
  return current === null || current === identity.procStartTime;
}
