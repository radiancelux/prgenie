import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isMeaningfulAgentLine,
  runAgentWithWatchdog,
  InactivityTracker,
} from "./stage-watchdog.js";

describe("stage watchdog", () => {
  it("detects meaningful stream-json lines", () => {
    assert.equal(isMeaningfulAgentLine('{"type":"assistant","message":{}}'), true);
    assert.equal(isMeaningfulAgentLine("[steer] queued"), false);
    assert.equal(isMeaningfulAgentLine(""), false);
  });

  it("InactivityTracker notes meaningful lines", () => {
    let t = 0;
    const tracker = new InactivityTracker(() => t, 0);
    t = 100;
    tracker.noteLine('{"type":"tool","name":"grep"}');
    assert.equal(tracker.silentForMs(), 0);
    t = 5100;
    assert.ok(tracker.silentForMs() >= 5000);
  });

  it("exhausts recovery after silent agent", async () => {
    let now = 0;
    const clock = () => now;
    let kills = 0;
    const res = await runAgentWithWatchdog(
      {
        policy: { inactivityMs: 50, stageCapMs: 60_000, recoveryAttempts: 0 },
        now: clock,
        tickMs: 25,
        childGraceMs: 1,
        killChild: () => {
          kills += 1;
        },
      },
      async () =>
        new Promise<{ code: number; output: string }>((_resolve, reject) => {
          const timer = setInterval(() => {
            now += 60;
          }, 20);
          setTimeout(() => {
            clearInterval(timer);
            reject(new Error("aborted"));
          }, 150);
        }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /meaningful agent activity/);
    assert.ok(kills >= 1);
  });
});
