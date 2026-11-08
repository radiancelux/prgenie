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
