import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { pidAlive } from "./pid-util.js";

export type ProcessActivitySample = {
  active: boolean;
  cpuPercent?: number;
  busiestComm?: string;
};

export type ProcessActivitySampler = {
  sample(rootPid: number | null | undefined): ProcessActivitySample;
};

type JiffySnapshot = Map<number, number>;

function readLinuxProcFieldRest(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return rest.length > 12 ? rest : null;
  } catch {
    return null;
  }
}

function readProcCpuJiffies(pid: number): number | null {
  if (process.platform !== "linux") return null;
  const rest = readLinuxProcFieldRest(pid);
  if (!rest) return null;
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return utime + stime;
}

function readProcComm(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function childPidsOf(ppid: number): number[] {
  if (process.platform !== "linux") return [];
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const rest = readLinuxProcFieldRest(pid);
    if (!rest) continue;
    const parent = Number(rest[1]);
    if (parent === ppid) out.push(pid);
  }
  return out;
}

function collectDescendantPids(root: number): number[] {
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of childPidsOf(pid)) stack.push(child);
  }
  seen.delete(root);
  return [...seen];
}

function coresForCpuPercent(): number {
  const n = os.cpus().length;
  return n > 0 ? n : 1;
}

export type ProcessActivitySamplerOptions = {
  clockHz?: number;
  now?: () => number;
};

/**
 * Compares jiffies between ticks for the agent subtree; the second sample onward reports activity.
 */
export function createProcessActivitySampler(
  opts: ProcessActivitySamplerOptions = {},
): ProcessActivitySampler {
  const clockHz = opts.clockHz ?? 100;
  const now = opts.now ?? Date.now;
  let last: JiffySnapshot | null = null;
  let lastAt = 0;

  return {
    sample(rootPid) {
      if (!rootPid || !pidAlive(rootPid)) {
        last = null;
        lastAt = 0;
        return { active: false };
      }
      const scan = [rootPid, ...collectDescendantPids(rootPid)];
      const jiffies: JiffySnapshot = new Map();
      for (const pid of scan) {
        const j = readProcCpuJiffies(pid);
        if (j != null) jiffies.set(pid, j);
      }
      const t = now();
      let active = false;
      let cpuPercent: number | undefined;
      let busiestComm: string | undefined;
      if (last && lastAt > 0 && jiffies.size) {
        const elapsedMs = t - lastAt;
        let maxDelta = 0;
        let maxPid: number | null = null;
        for (const [pid, j] of jiffies) {
          const prev = last.get(pid);
          if (prev === undefined) continue;
          const delta = j - prev;
          if (delta > maxDelta) {
            maxDelta = delta;
            maxPid = pid;
          }
        }
        if (maxDelta > 0 && elapsedMs > 0) {
          active = true;
          const cpuSec = maxDelta / clockHz;
          const wallSec = elapsedMs / 1000;
          cpuPercent = Math.min(
            9999,
            Math.round((cpuSec / wallSec) * (100 / coresForCpuPercent())),
          );
          busiestComm = maxPid != null ? (readProcComm(maxPid) ?? undefined) : undefined;
        }
      }
      last = jiffies;
      lastAt = t;
      return { active, cpuPercent, busiestComm };
    },
  };
}
