import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createProcessActivitySampler } from "./watchdog-process-activity.js";

describe("watchdog process activity", () => {
  it("returns inactive without a live root pid", () => {
    const sampler = createProcessActivitySampler();
    assert.deepEqual(sampler.sample(null), { active: false });
    assert.deepEqual(sampler.sample(9_999_999), { active: false });
  });

  it("detects a busy descendant on linux", async () => {
    if (process.platform !== "linux") return;
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }); setInterval(() => {}, 60_000);",
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve) => {
      child.once("spawn", () => resolve());
    });
    try {
      const sampler = createProcessActivitySampler({ now: () => Date.now() });
      sampler.sample(child.pid);
      await new Promise((r) => setTimeout(r, 120));
      const second = sampler.sample(child.pid);
      assert.equal(second.active, true, "busy child should count as activity");
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });
});
