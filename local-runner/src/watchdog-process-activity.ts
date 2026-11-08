import { readdirSync, readFileSync } from "node:fs";
import { pidAlive } from "./pid-util.js";

export type ProcessActivitySample = {
  active: boolean;
  /** Top-style per-core percentage for the busiest descendant (can exceed 100). */
  cpuPercent?: number;
  busiestComm?: string;
};

export type ProcessActivitySampler = {
  sample(rootPid: number | null | undefined): ProcessActivitySample;
};

export type ProcEntry = { ppid: number; jiffies: number };

/** pid → parent pid and cumulative utime+stime jiffies. */
export type ProcTable = Map<number, ProcEntry>;

/** One pass over `/proc`: each process's stat is read exactly once per sample. */
export function readLinuxProcTable(): ProcTable {
  const table: ProcTable = new Map();
  if (process.platform !== "linux") return table;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return table;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      continue;
    }
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (rest.length <= 12) continue;
    const ppid = Number(rest[1]);
    const jiffies = Number(rest[11]) + Number(rest[12]);
    if (!Number.isFinite(ppid) || !Number.isFinite(jiffies)) continue;
    table.set(pid, { ppid, jiffies });
  }
  return table;
}

function readLinuxProcComm(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Descendants of `root` (excluding `root` itself). */
export function descendantPids(table: ProcTable, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

export type ProcessActivitySamplerOptions = {
  clockHz?: number;
  now?: () => number;
  /** Per-core CPU % a single descendant must reach for a sample to count as busy. */
  minCpuPercent?: number;
  /** Consecutive busy samples required before reporting activity. */
  sustainSamples?: number;
  readTable?: () => ProcTable;
  readComm?: (pid: number) => string | null;
  isAlive?: (pid: number) => boolean;
};

export const DEFAULT_MIN_CPU_PERCENT = 20;
export const DEFAULT_SUSTAIN_SAMPLES = 3;

/**
 * Compares CPU jiffies of the agent's descendants (never the agent CLI itself) between samples.
 * Activity is reported only once one descendant stays above `minCpuPercent` for
 * `sustainSamples` consecutive samples, so background keep-alive noise never counts.
 */
export function createProcessActivitySampler(
  opts: ProcessActivitySamplerOptions = {},
): ProcessActivitySampler {
  const clockHz = opts.clockHz ?? 100;
  const now = opts.now ?? Date.now;
  const minCpuPercent = opts.minCpuPercent ?? DEFAULT_MIN_CPU_PERCENT;
  const sustainSamples = Math.max(1, opts.sustainSamples ?? DEFAULT_SUSTAIN_SAMPLES);
  const readTable = opts.readTable ?? readLinuxProcTable;
  const readComm = opts.readComm ?? readLinuxProcComm;
  const isAlive = opts.isAlive ?? pidAlive;
  let last: Map<number, number> | null = null;
  let lastRoot: number | null = null;
  let lastAt = 0;
  let streak = 0;

  const reset = () => {
    last = null;
    lastRoot = null;
    lastAt = 0;
    streak = 0;
  };

  return {
    sample(rootPid) {
      if (!rootPid || !isAlive(rootPid)) {
        reset();
        return { active: false };
      }
      if (rootPid !== lastRoot) reset();
      const table = readTable();
      const jiffies = new Map<number, number>();
      for (const pid of descendantPids(table, rootPid)) {
        jiffies.set(pid, table.get(pid)!.jiffies);
      }
      const t = now();
      const prev = last;
      const elapsedMs = t - lastAt;
      last = jiffies;
      lastRoot = rootPid;
      lastAt = t;
      if (!prev || elapsedMs <= 0) return { active: false };

      let maxDelta = 0;
      let maxPid: number | null = null;
      for (const [pid, j] of jiffies) {
        const before = prev.get(pid);
        if (before === undefined) continue;
        const delta = j - before;
        if (delta > maxDelta) {
          maxDelta = delta;
          maxPid = pid;
        }
      }
      if (maxPid == null) {
        streak = 0;
        return { active: false };
      }
      const cpuPercent = Math.round((maxDelta / clockHz / (elapsedMs / 1000)) * 100);
      streak = cpuPercent >= minCpuPercent ? streak + 1 : 0;
      return {
        active: streak >= sustainSamples,
        cpuPercent,
        busiestComm: readComm(maxPid) ?? undefined,
      };
    },
  };
}
