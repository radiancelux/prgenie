import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isMeaningfulAgentLine,
  runAgentWithWatchdog,
  InactivityTracker,
} from "./stage-watchdog.js";
import { AgentRunner, type AgentDriverRunResult } from "./agent.js";
import type { RunnerConfig } from "./config.js";
import { JobControl } from "./job-control.js";
import { runJobLoop } from "./job-runner.js";
import { saveSettings } from "./settings.js";
import { createJob, loadJob } from "./store.js";
import { escalatingKill } from "./drivers/driver-types.js";

/** First run stays silent until killed; every later run reports progress and exits 0. */
class SilentOnceRunner extends AgentRunner {
  calls = 0;
  kills = 0;
  private release: (() => void) | null = null;

  constructor(private readonly advanceClock: (ms: number) => void) {
    super();
  }

  override async run(): Promise<AgentDriverRunResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return new Promise((resolve) => {
        const timer = setInterval(() => this.advanceClock(30_000), 5);
        this.release = () => {
          clearInterval(timer);
          resolve({ code: 143, output: "" });
        };
      });
    }
    this.emit("line", '{"type":"assistant","message":{}}');
    return { code: 0, output: "ok" };
  }

  override kill(): void {
    this.kills += 1;
    this.release?.();
    this.release = null;
  }
}

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

describe("stage watchdog", () => {
  it("detects meaningful stream-json lines", () => {
    assert.equal(isMeaningfulAgentLine('{"type":"assistant","message":{}}'), true);
    assert.equal(isMeaningfulAgentLine("[steer] queued"), false);
    assert.equal(isMeaningfulAgentLine(""), false);
  });

  it("pollActivity counts as agent progress for inactivity", async () => {
    let now = 0;
    const res = await runAgentWithWatchdog(
      {
        policy: { inactivityMs: 40, stageCapMs: 60_000, recoveryAttempts: 0 },
        now: () => now,
        tickMs: 10,
        childGraceMs: 1,
        killChild: () => undefined,
        pollActivity: () => {
          now += 15;
          return true;
        },
      },
      async () => {
        const deadline = now + 120;
        while (now < deadline) {
          await new Promise((r) => setTimeout(r, 5));
          now += 10;
        }
        return { code: 0, output: "ok" };
      },
    );
    assert.equal(res.ok, true);
  });

  it("an idle pollActivity still trips the inactivity limit", async () => {
    let now = 0;
    let polls = 0;
    let killed = false;
    const res = await runAgentWithWatchdog(
      {
        policy: { inactivityMs: 40, stageCapMs: 60_000, recoveryAttempts: 0 },
        now: () => now,
        tickMs: 10,
        childGraceMs: 1,
        killChild: () => {
          killed = true;
        },
        pollActivity: () => {
          polls += 1;
          now += 15;
          return false;
        },
      },
      async () => {
        while (!killed) await new Promise((r) => setTimeout(r, 5));
        return { code: 1, output: "" };
      },
    );
    assert.ok(polls > 0);
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.reason, /no meaningful agent activity/);
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

  it("kills a silent agent, retries, and returns the retried run's result", async () => {
    let now = 0;
    const runner = new SilentOnceRunner((ms) => {
      now += ms;
    });
    const recoveries: number[] = [];
    const res = await runAgentWithWatchdog(
      {
        policy: { inactivityMs: 60_000, stageCapMs: 3_600_000, recoveryAttempts: 1 },
        now: () => now,
        tickMs: 5,
        childGraceMs: 1,
        killChild: () => runner.kill(),
        onRecovery: (attempt) => recoveries.push(attempt),
      },
      () => runner.run(),
    );
    assert.equal(res.ok, true);
    assert.equal(res.recoveryAttempts, 1);
    if (res.ok) assert.deepEqual(res.value, { code: 0, output: "ok" });
    assert.deepEqual(recoveries, [1]);
    assert.equal(runner.calls, 2);
    assert.ok(runner.kills >= 1);
  });

  it("gives up on a child that ignores kill once the grace period expires", async () => {
    let now = 0;
    let kills = 0;
    const clock = setInterval(() => {
      now += 25;
    }, 5);
    const res = await runAgentWithWatchdog(
      {
        policy: { inactivityMs: 3_600_000, stageCapMs: 100, recoveryAttempts: 0 },
        now: () => now,
        tickMs: 5,
        childGraceMs: 50,
        killChild: () => {
          kills += 1;
        },
      },
      () => new Promise<never>(() => undefined),
    ).finally(() => clearInterval(clock));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /hard cap/);
    assert.equal(kills, 1, "kill is sent once, not re-sent every tick");
  });

  it("escalatingKill sends SIGKILL to a child that traps SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("exit", (_code, signal) => resolve(signal)),
    );
    const handle = escalatingKill(() => child, 50);
    handle.kill();
    handle.kill();
    assert.equal(await exited, "SIGKILL");
  });

  it("job proceeds to approved after the watchdog recovers a silent build stage", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-wd-job-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-wd-repo-"));
    const config = testConfig(dataDir);
    await saveSettings(dataDir, { watchdog: { inactivityMs: 60_000, recoveryAttempts: 1 } });
    const job = await createJob(
      dataDir,
      {
        repoPath: repo,
        branch: "feat/wd",
        promptFile: path.join(repo, "missing-prompt.md"),
        maxRounds: 1,
        dryRun: true,
      },
      { model: "composer-2.5", dryRun: true, config },
    );
    assert.equal(job.effectiveSnapshot?.watchdogRecoveryAttempts, 1);

    let now = 0;
    const runner = new SilentOnceRunner((ms) => {
      now += ms;
    });
    await runJobLoop(config, job, JobControl.fromPersisted(job), {
      agentRunner: runner,
      watchdogTiming: { now: () => now, tickMs: 5, childGraceMs: 1 },
    });

    assert.equal(job.stage, "approved", job.error ?? "");
    assert.equal(job.error, null);
    assert.equal(runner.calls, 3, "silent build, retried build, review");
    assert.ok(runner.kills >= 1);
    assert.equal(job.watchdog?.recoveryAttemptsUsed, 1);
    assert.ok(job.watchdog?.lastRecoveryAt);
    assert.match(job.watchdog?.lastStallReason ?? "", /meaningful agent activity/);

    const persisted = await loadJob(dataDir, job.id);
    assert.equal(persisted?.stage, "approved");
    assert.equal(persisted?.watchdog?.recoveryAttemptsUsed, 1);
  });
});
