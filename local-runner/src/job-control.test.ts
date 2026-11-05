import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JobControl } from "./job-control.js";
import type { JobRecord } from "./types.js";

function minimalJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: null,
    prNumber: null,
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    ...overrides,
  };
}

describe("JobControl", () => {
  it("requestStop aborts signal and invokes registered kill", () => {
    const control = new JobControl();
    let killed = false;
    control.registerKill(() => {
      killed = true;
    });
    control.requestStop();
    assert.equal(control.stopRequested, true);
    assert.equal(control.signal.aborted, true);
    assert.equal(killed, true);
  });

  it("registerKill after stop still kills in-flight agent", () => {
    const control = new JobControl();
    control.requestStop();
    let killed = false;
    control.registerKill(() => {
      killed = true;
    });
    assert.equal(killed, true);
  });

  it("drains steer queue without touching JobRecord", () => {
    const job = minimalJob({ steerQueue: ["persisted"] });
    const control = JobControl.fromPersisted(job);
    control.pushSteer("live");
    assert.deepEqual(job.steerQueue, ["persisted"]);
    assert.equal(control.drainSteer(), "persisted\n\nlive");
    assert.equal(control.drainSteer(), "");
  });

  it("fromPersisted honors stopRequested", () => {
    const control = JobControl.fromPersisted(minimalJob({ stopRequested: true }));
    assert.equal(control.stopRequested, true);
    assert.equal(control.signal.aborted, true);
  });
});
