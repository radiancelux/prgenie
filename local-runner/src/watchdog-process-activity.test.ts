import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createProcessActivitySampler,
  descendantPids,
  type ProcTable,
} from "./watchdog-process-activity.js";

function fakeSampler(
  tables: ProcTable[],
  opts: { minCpuPercent?: number; sustainSamples?: number } = {},
) {
  let t = 0;
  let i = 0;
  return createProcessActivitySampler({
    ...opts,
    now: () => (t += 1000),
    readTable: () => tables[Math.min(i++, tables.length - 1)],
    readComm: (pid) => `p${pid}`,
    isAlive: () => true,
  });
}

/** Root 10 → child 11 → grandchild 12; jiffies per pid at 100Hz. */
function table(root: number, child: number, grandchild: number): ProcTable {
  return new Map([
    [10, { ppid: 1, jiffies: root }],
    [11, { ppid: 10, jiffies: child }],
    [12, { ppid: 11, jiffies: grandchild }],
    [99, { ppid: 1, jiffies: 0 }],
  ]);
}

async function spawnTree(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", detached: true });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  await new Promise((r) => setTimeout(r, 200));
  return child;
}

function killTree(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

describe("watchdog process activity", () => {
  it("returns inactive without a live root pid", () => {
    const sampler = createProcessActivitySampler();
    assert.deepEqual(sampler.sample(null), { active: false });
    assert.deepEqual(sampler.sample(9_999_999), { active: false });
  });

  it("descendantPids walks the subtree once and excludes the root", () => {
    assert.deepEqual(descendantPids(table(0, 0, 0), 10).sort(), [11, 12]);
    assert.deepEqual(descendantPids(table(0, 0, 0), 12), []);
  });

  it("ignores CPU burned by the agent root itself", () => {
    const sampler = fakeSampler([table(0, 0, 0), table(100, 0, 0), table(200, 0, 0)], {
      sustainSamples: 1,
    });
    for (let n = 0; n < 3; n++) assert.equal(sampler.sample(10).active, false);
  });

  it("ignores low CPU noise in descendants", () => {
    const sampler = fakeSampler([table(0, 0, 0), table(0, 1, 0), table(0, 2, 0), table(0, 3, 0)], {
      sustainSamples: 1,
    });
    for (let n = 0; n < 4; n++) assert.equal(sampler.sample(10).active, false);
  });

  it("requires sustained CPU before reporting activity", () => {
    const sampler = fakeSampler(
      [
        table(0, 0, 0),
        table(0, 0, 270),
        table(0, 0, 540),
        table(0, 0, 540),
        table(0, 0, 810),
        table(0, 0, 1080),
      ],
      { sustainSamples: 2 },
    );
    assert.equal(sampler.sample(10).active, false);
    const first = sampler.sample(10);
    assert.equal(first.active, false);
    assert.equal(first.cpuPercent, 270);
    assert.equal(first.busiestComm, "p12");
    assert.equal(sampler.sample(10).active, true);
    assert.equal(sampler.sample(10).active, false, "an idle sample resets the streak");
    assert.equal(sampler.sample(10).active, false);
    assert.equal(sampler.sample(10).active, true);
  });

  it("detects a busy descendant on linux", async () => {
    if (process.platform !== "linux") return;
    const child = await spawnTree(
      "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }); setInterval(() => {}, 60_000);",
    );
    try {
      const sampler = createProcessActivitySampler({ sustainSamples: 1 });
      sampler.sample(child.pid);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sampler.sample(child.pid).active, true, "busy child should count as activity");
    } finally {
      killTree(child);
    }
  });

  it("treats an idle descendant as inactive on linux", async () => {
    if (process.platform !== "linux") return;
    const child = await spawnTree(
      "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' }); setInterval(() => {}, 60_000);",
    );
    try {
      const sampler = createProcessActivitySampler({ sustainSamples: 1 });
      sampler.sample(child.pid);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sampler.sample(child.pid).active, false);
    } finally {
      killTree(child);
    }
  });

  it("does not count a busy agent root with idle children on linux", async () => {
    if (process.platform !== "linux") return;
    const child = await spawnTree(
      "const { spawn } = require('node:child_process'); spawn('sleep', ['60'], { stdio: 'ignore' }); const end = Date.now() + 5_000; while (Date.now() < end) {}",
    );
    try {
      const sampler = createProcessActivitySampler({ sustainSamples: 1 });
      sampler.sample(child.pid);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sampler.sample(child.pid).active, false);
    } finally {
      killTree(child);
    }
  });
});
