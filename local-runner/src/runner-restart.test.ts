import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { createJob, loadJob, saveJob, updateJobWorker } from "./store.js";
import { bindRunnerHttpServer } from "./http-bind.js";
import { startHttpServer, type RunnerHttpServer } from "./server.js";
import { saveSettings } from "./settings.js";
import {
  claimJobWorker,
  liveWorkerLock,
  readWorkerLock,
  releaseJobWorker,
  touchWorkerHeartbeat,
  workerLockFile,
} from "./job-worker-lock.js";
import { pidAlive, processIdentityAlive, readProcStartTime } from "./pid-util.js";
import { findBuildRoot, runRunnerRestartCli, waitForPortFree } from "./runner-restart.js";
import { jobFile } from "./paths.js";
import type { JobEvent } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runnerBin = path.join(repoRoot, "local-runner/dist/runner.cjs");

function cfg(dataDir: string, port: number): RunnerConfig {
  return {
    host: "127.0.0.1",
    port,
    token: "restart-test-token",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

function workerLauncherEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PRGENIE_RUNNER_BINARY: runnerBin,
    PRGENIE_RUNNER_ROLE: "serve",
    PRGENIE_RUNNER_DETACHED_JOBS: "1",
    PRGENIE_RUNNER_SLOW_MS: "3000",
    PRGENIE_RUNNER_WORKER_HEARTBEAT_MS: "200",
  };
}

async function reservePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  assert.notEqual(port, 9473, "tests must not bind live runner port 9473");
  return port;
}

async function waitUntil(
  fn: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout: ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for a worker process; `ignoreTerm` makes it survive SIGTERM like a wedged worker. */
function spawnSleeper(ignoreTerm = false): ChildProcess {
  const script = ignoreTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : "setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

function killQuiet(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Exited (zombies count: the test process may not have reaped them yet). */
function gone(child: ChildProcess): boolean {
  return !processIdentityAlive({ pid: child.pid! });
}

function countClaims(log: string): number {
  return (log.match(/\[job-worker\] pid \d+ claimed job/g) ?? []).length;
}

function httpRequest(
  port: number,
  method: string,
  reqPath: string,
  token: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () =>
          resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Open a dashboard SSE stream and resolve once the server has sent its first frame. */
function openSse(
  port: number,
  token: string,
  ssePath = "/api/events",
): Promise<{ ended: Promise<void>; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: ssePath, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const ended = new Promise<void>((r) => {
          res.on("end", () => r());
          res.on("close", () => r());
        });
        res.once("data", () => resolve({ ended, req }));
        res.resume();
      },
    );
    req.on("error", reject);
  });
}

describe("live runner restart (detached workers)", () => {
  const envBefore = { ...process.env };
  const sleepers: ChildProcess[] = [];
  let dataDir = "";
  let port = 0;

  before(async () => {
    delete process.env.PRGENIE_RUNNER_INLINE_JOBS;
    Object.assign(process.env, workerLauncherEnv());
    port = await reservePort();
    process.env.PRGENIE_RUNNER_TOKEN = "restart-test-token";
  });

  // Each test gets its own store so one engine's init never adopts another test's jobs.
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-restart-"));
    process.env.PRGENIE_RUNNER_DATA_DIR = dataDir;
    await saveSettings(dataDir, { maxActiveJobs: 8 });
  });

  afterEach(() => {
    for (const s of sleepers.splice(0)) killQuiet(s);
  });

  after(() => {
    process.env = envBefore;
  });

  function sleeper(ignoreTerm = false): ChildProcess {
    const child = spawnSleeper(ignoreTerm);
    sleepers.push(child);
    return child;
  }

  async function seedJob(
    stage: "building" | "reviewing" | "fixing",
    reviewRound: number,
    opts: { withPr?: boolean; driver?: string } = {},
  ): Promise<string> {
    const driver = opts.driver ?? "slow-dry-run";
    const job = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: `feat/restart-${stage}-${reviewRound}-${Date.now()}-${Math.random()}`,
        promptFile: "/p.md",
        maxRounds: 1,
        dryRun: true,
        driver,
      },
      { model: "composer-2.5", dryRun: true, config: cfg(dataDir, port) },
    );
    job.driverId = driver;
    job.stage = stage;
    job.reviewRound = reviewRound;
    if (opts.withPr ?? stage !== "building") {
      job.prUrl = "https://github.com/example/example/pull/1";
      job.prNumber = 1;
    }
    await saveJob(dataDir, job);
    return job.id;
  }

  /** Hand `jobId` to a fake worker process: a real lock + mirror owned by `child`. */
  async function claimFor(jobId: string, child: ChildProcess): Promise<string> {
    const claim = await claimJobWorker(dataDir, jobId, { pid: child.pid! });
    assert.ok(claim.ok);
    return claim.worker.token;
  }

  for (const stage of ["building", "reviewing", "fixing"] as const) {
    it(`re-adopts a job in ${stage} across serve restart without duplicate workers`, async () => {
      const reviewRound = stage === "building" ? 0 : 1;
      const jobId = await seedJob(stage, reviewRound);
      const config = cfg(dataDir, port);
      const engineA = new RunnerEngine(config, {
        watchCi: false,
        workerSupervisor: { pollMs: 100 },
      });
      await engineA.init();

      // The worker creates its lock file before mirroring `worker` into the job record.
      await waitUntil(async () => {
        const lock = liveWorkerLock(dataDir, jobId);
        return !!lock && (await loadJob(dataDir, jobId))?.worker?.token === lock.token;
      }, `worker alive and mirrored (${stage})`);
      const firstWorker = liveWorkerLock(dataDir, jobId)!;
      assert.ok(pidAlive(firstWorker.pid));
      assert.equal((await loadJob(dataDir, jobId))?.worker?.token, firstWorker.token);
      const adoptedAt = Date.now();

      const engineB = new RunnerEngine(config, {
        watchCi: false,
        workerSupervisor: { pollMs: 100 },
      });
      const events: JobEvent[] = [];
      engineB.on("event", (id: string, ev: JobEvent) => {
        if (id === jobId) events.push(ev);
      });
      await engineB.init();
      assert.ok(engineB.isRunning(jobId), "engine B adopts the live worker");
      assert.equal(liveWorkerLock(dataDir, jobId)?.pid, firstWorker.pid, "no second worker");

      await waitUntil(async () => (await loadJob(dataDir, jobId))?.stage === "approved", stage);
      await waitUntil(() => !engineB.isRunning(jobId), "engine B supervision ends");

      const finalJob = await loadJob(dataDir, jobId);
      assert.equal(finalJob?.stage, "approved");
      const log = await readFile(finalJob!.logPath, "utf8");
      assert.match(log, /slow agent/);
      assert.equal(countClaims(log), 1, "exactly one worker ran the job");
      // The worker's own per-stage watchdog kept running after adoption: the review stage that
      // follows build/fix started post-adoption and stamped a fresh stage clock.
      const lastStageStart = Date.parse(finalJob!.watchdog!.stageStartedAt!);
      if (stage !== "reviewing") assert.ok(lastStageStart >= adoptedAt);
      else assert.ok(lastStageStart >= Date.parse(firstWorker.startedAt));
      // Engine B forwarded the worker's progress to dashboard listeners.
      const stages = events
        .filter((e) => e.type === "stage")
        .map((e) => (e as { stage: string }).stage);
      assert.ok(stages.includes("approved"), `stage events after adoption: ${stages.join(",")}`);
      assert.ok(
        events.some((e) => e.type === "log"),
        "log events after adoption",
      );
      // Release is explicit and persisted, not undone by later saves.
      assert.equal(liveWorkerLock(dataDir, jobId), null);
      const raw = JSON.parse(await readFile(jobFile(dataDir, jobId), "utf8")) as {
        worker?: unknown;
      };
      assert.equal(raw.worker, null);
    });
  }

  it("simultaneous engine startup runs exactly one worker per job", async () => {
    const jobId = await seedJob("building", 0);
    const config = cfg(dataDir, port);
    const engines = [0, 1, 2].map(
      () => new RunnerEngine(config, { watchCi: false, workerSupervisor: { pollMs: 100 } }),
    );
    await Promise.all(engines.map((e) => e.init()));

    await waitUntil(async () => (await loadJob(dataDir, jobId))?.stage === "approved", "done");
    await waitUntil(() => engines.every((e) => !e.isRunning(jobId)), "supervision ends");
    const job = await loadJob(dataDir, jobId);
    assert.equal(job?.stage, "approved");
    assert.equal(countClaims(await readFile(job!.logPath, "utf8")), 1);
  });

  it("concurrent claims in one process have a single winner", async () => {
    const jobId = await seedJob("building", 0);
    const results = await Promise.all([0, 1, 2, 3].map(() => claimJobWorker(dataDir, jobId)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    const winner = results.find((r) => r.ok)!;
    assert.ok(winner.ok);
    for (const r of results) if (!r.ok) assert.equal(r.holder?.token, winner.worker.token);
    await releaseJobWorker(dataDir, jobId, winner.worker.token);
    assert.equal(readWorkerLock(dataDir, jobId), null);
  });

  it("a job-worker process refuses a job another live worker owns (exit 3)", async () => {
    const jobId = await seedJob("building", 0);
    const holder = sleeper();
    const token = await claimFor(jobId, holder);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [runnerBin, "job-worker", jobId], {
        env: { ...process.env, PRGENIE_RUNNER_INLINE_JOBS: "1", PRGENIE_RUNNER_ROLE: "job-worker" },
        stdio: "ignore",
      });
      child.on("exit", (c) => resolve(c));
    });
    assert.equal(code, 3);
    assert.equal(readWorkerLock(dataDir, jobId)?.token, token, "holder keeps the lock");
    const job = await loadJob(dataDir, jobId);
    assert.equal(job?.stage, "building");
    assert.equal(job?.worker?.token, token);
  });

  it("clearing the worker is explicit and survives stale saves", async () => {
    const jobId = await seedJob("building", 0);
    const stale = (await loadJob(dataDir, jobId))!;
    const holder = sleeper();
    const token = await claimFor(jobId, holder);

    // A copy loaded before the claim must not drop it.
    stale.title = "stale write";
    await saveJob(dataDir, stale);
    assert.equal((await loadJob(dataDir, jobId))?.worker?.token, token);

    const preRelease = (await loadJob(dataDir, jobId))!;
    await releaseJobWorker(dataDir, jobId, token);
    // A copy loaded before the release must not revive it.
    preRelease.title = "pre-release write";
    await saveJob(dataDir, preRelease);
    const after = JSON.parse(await readFile(jobFile(dataDir, jobId), "utf8")) as {
      worker?: unknown;
      title: string;
    };
    assert.equal(after.title, "pre-release write");
    assert.equal(after.worker, null);

    // Explicit null through saveJob also persists.
    const token2 = await claimFor(jobId, holder);
    const j = (await loadJob(dataDir, jobId))!;
    assert.equal(j.worker?.token, token2);
    j.worker = null;
    await saveJob(dataDir, j);
    assert.equal((await loadJob(dataDir, jobId))?.worker, undefined);
  });

  it("PID reuse: a recycled pid is neither adopted nor signalled", async () => {
    const jobId = await seedJob("building", 0);
    const imposter = sleeper();
    const real = readProcStartTime(imposter.pid!);
    // Same pid, different process start time: what a recycled PID looks like.
    await mkdir(path.dirname(workerLockFile(dataDir, jobId)), { recursive: true });
    const now = new Date().toISOString();
    const record = {
      pid: imposter.pid!,
      hostname: os.hostname(),
      startedAt: now,
      heartbeatAt: now,
      token: "old-worker",
      procStartTime: real ? `${real}0` : "not-a-start-time",
    };
    await writeFile(workerLockFile(dataDir, jobId), JSON.stringify(record));
    await updateJobWorker(dataDir, jobId, () => record);

    if (real) assert.equal(liveWorkerLock(dataDir, jobId), null, "identity mismatch");
    const engine = new RunnerEngine(cfg(dataDir, port), { watchCi: false });
    await engine.stop(jobId);
    await sleep(200);
    assert.ok(pidAlive(imposter.pid!), "stop must not SIGTERM a recycled pid");

    if (!real) return; // platform without start times: covered by heartbeat checks instead
    const j = await loadJob(dataDir, jobId);
    j!.stopRequested = false;
    await saveJob(dataDir, j!);
    await engine.init();
    const reloaded = await loadJob(dataDir, jobId);
    assert.equal(reloaded?.stage, "interrupted", "not adopted");
    assert.ok(pidAlive(imposter.pid!));
    assert.equal(readWorkerLock(dataDir, jobId), null, "stale lock cleared");
  });

  it("marks orphaned active jobs interrupted when the worker is gone", async () => {
    const jobId = await seedJob("building", 0, { driver: "cursor-agent" });
    await updateJobWorker(dataDir, jobId, () => ({
      pid: 2_147_483_640,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));

    const engine = new RunnerEngine(cfg(dataDir, port), { watchCi: false });
    await engine.init();
    const reloaded = await loadJob(dataDir, jobId);
    assert.equal(reloaded?.stage, "interrupted");
    assert.match(reloaded?.error ?? "", /Interrupted \(worker_exit\)/);
    assert.equal(reloaded?.worker, undefined);
  });

  it("an adopted live worker is never interrupted while it heartbeats", async () => {
    const jobId = await seedJob("reviewing", 1);
    const child = sleeper();
    const token = await claimFor(jobId, child);
    const beat = setInterval(() => touchWorkerHeartbeat(dataDir, jobId, token), 50);
    try {
      const engine = new RunnerEngine(cfg(dataDir, port), {
        watchCi: false,
        workerSupervisor: { pollMs: 50, heartbeatStaleMs: 1_000 },
      });
      await engine.init();
      assert.ok(engine.isRunning(jobId));
      await sleep(1_500);
      assert.equal((await loadJob(dataDir, jobId))?.stage, "reviewing");
      assert.ok(pidAlive(child.pid!));

      // The worker exits without settling: only now does the job become interrupted.
      killQuiet(child);
      await waitUntil(async () => (await loadJob(dataDir, jobId))?.stage === "interrupted", "dead");
      assert.match((await loadJob(dataDir, jobId))?.error ?? "", /worker_exit/);
    } finally {
      clearInterval(beat);
    }
  });

  it("watchdog keeps enforcing the stage budget after adoption", async () => {
    const jobId = await seedJob("fixing", 1);
    const j = (await loadJob(dataDir, jobId))!;
    j.watchdog = {
      lastActivityAt: new Date().toISOString(),
      stageStartedAt: new Date().toISOString(),
      recoveryAttemptsUsed: 0,
      lastRecoveryAt: null,
      lastStallReason: null,
    };
    await saveJob(dataDir, j);
    const child = sleeper();
    const token = await claimFor(jobId, child);
    const beat = setInterval(() => touchWorkerHeartbeat(dataDir, jobId, token), 50);
    let skewMs = 0;
    try {
      const engine = new RunnerEngine(cfg(dataDir, port), {
        watchCi: false,
        workerSupervisor: {
          pollMs: 50,
          killGraceMs: 500,
          heartbeatStaleMs: 24 * 3_600_000,
          now: () => Date.now() + skewMs,
        },
      });
      await engine.init();
      await sleep(300);
      assert.equal((await loadJob(dataDir, jobId))?.stage, "fixing", "within budget");

      // Jump past this job's stage budget (default 120 min cap × (1 + 1 recovery) + slack).
      skewMs = 6 * 3_600_000;
      await waitUntil(async () => (await loadJob(dataDir, jobId))?.stage === "interrupted", "cap");
      assert.ok(gone(child), "worker stopped before the job was marked");
      assert.match((await loadJob(dataDir, jobId))?.error ?? "", /worker_watchdog.*fixing/);
    } finally {
      clearInterval(beat);
    }
  });

  it("stale heartbeat: supervisor escalates to SIGKILL and confirms death first", async () => {
    const jobId = await seedJob("building", 0);
    const wedged = sleeper(true);
    await claimFor(jobId, wedged);
    const engine = new RunnerEngine(cfg(dataDir, port), {
      watchCi: false,
      workerSupervisor: { pollMs: 50, killGraceMs: 400, heartbeatStaleMs: 300 },
    });
    await engine.init();
    await waitUntil(async () => (await loadJob(dataDir, jobId))?.stage === "interrupted", "hb");
    assert.ok(gone(wedged));
    assert.match((await loadJob(dataDir, jobId))?.error ?? "", /heartbeat stale/);
  });

  it("continue_job resumes an interrupted pre-PR job by re-running its build stage", async () => {
    const jobId = await seedJob("building", 0, { withPr: false });
    await updateJobWorker(dataDir, jobId, () => ({
      pid: 2_147_483_641,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));
    const config = cfg(dataDir, port);
    const engine = new RunnerEngine(config, { watchCi: false, workerSupervisor: { pollMs: 100 } });
    await engine.init();
    const interrupted = await loadJob(dataDir, jobId);
    assert.equal(interrupted?.stage, "interrupted");
    assert.equal(interrupted?.prUrl, null);

    const res = await engine.continueJob({ id: jobId, prompt: "pick up where you left off" });
    assert.equal(res.stage, "building");
    assert.equal(res.maxRounds, 1, "a build resume spends no extra rounds");
    await waitUntil(async () => (await loadJob(dataDir, jobId))?.stage === "approved", "resume");
    const done = await loadJob(dataDir, jobId);
    assert.equal(done?.stage, "approved");
    assert.equal(done?.prUrl, null, "dry-run resume does not fabricate a GitHub PR URL");
    assert.equal(done?.continueHistory?.[0].resumedStage, "building");
    assert.equal(done?.continueHistory?.[0].prompt, "pick up where you left off");
    assert.deepEqual(done?.steerQueue, [], "the build stage consumed the resume prompt");
    assert.equal(countClaims(await readFile(done!.logPath, "utf8")), 1);
  });

  it("POST /api/runner/restart exits promptly with dashboard SSE clients open", async () => {
    const isoDir = await mkdtemp(path.join(os.tmpdir(), "lr-restart-http-"));
    const p = await reservePort();
    const config = cfg(isoDir, p);
    const engine = new RunnerEngine(config, { watchCi: false });
    await engine.init();
    let exitedAt = 0;
    const server = startHttpServer(config, engine, {
      onProcessExit: () => {
        exitedAt = Date.now();
      },
    });
    await bindRunnerHttpServer(server, config.host, config.port);

    const list = await openSse(p, config.token);
    const jobStream = await openSse(p, config.token, "/api/jobs/does-not-exist/stream");
    const started = Date.now();
    const res = await httpRequest(p, "POST", "/api/runner/restart", config.token, "{}");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { ok: boolean; idle: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.idle, true);

    await Promise.all([list.ended, jobStream.ended]);
    await waitUntil(() => exitedAt > 0, "process exit hook", 5_000);
    assert.ok(exitedAt - started < 1_500, `restart took ${exitedAt - started}ms`);
    assert.equal(server.listening, false);
    assert.ok(await waitForPortFree("127.0.0.1", p, 1_000));
  });
});

describe("prgenie restart --build", () => {
  it("finds the repo root from the bundled runner paths, not local-runner/", () => {
    assert.equal(findBuildRoot(path.join(repoRoot, "local-runner/dist/runner.cjs")), repoRoot);
    assert.equal(findBuildRoot(path.join(repoRoot, "packages/npm-prgenie/runner.cjs")), repoRoot);
    assert.equal(findBuildRoot(path.join(repoRoot, "local-runner/src/bin.ts")), repoRoot);
    assert.equal(findBuildRoot(path.join(os.tmpdir(), "nowhere", "runner.cjs")), null);
  });

  const base = {
    entry: path.join(repoRoot, "local-runner/dist/runner.cjs"),
    host: "127.0.0.1",
    port: 1,
    token: "t",
  };
  const quiet = { log: () => undefined, error: () => undefined };

  it("aborts before touching the old server when the build fails", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const code = await runRunnerRestartCli(
      { ...base, build: true },
      {
        ...quiet,
        error: (m) => errors.push(m),
        build: async (root) => {
          calls.push(`build:${root}`);
          throw new Error("tsc exploded");
        },
        callRestart: async () => {
          calls.push("restart");
          return { status: 200, body: {} };
        },
        launch: () => calls.push("launch"),
      },
    );
    assert.equal(code, 1);
    assert.deepEqual(calls, [`build:${repoRoot}`]);
    assert.match(errors.join("\n"), /Build failed; runner left running: tsc exploded/);
  });

  it("builds first, then restarts, waits for the port, and relaunches", async () => {
    const calls: string[] = [];
    const code = await runRunnerRestartCli(
      { ...base, build: true },
      {
        ...quiet,
        build: async () => void calls.push("build"),
        callRestart: async () => {
          calls.push("restart");
          return { status: 200, body: { ok: true } };
        },
        waitForPortFree: async () => (calls.push("port-free"), true),
        launch: () => calls.push("launch"),
        waitForUp: async () => (calls.push("up"), true),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(calls, ["build", "restart", "port-free", "launch", "up"]);
  });

  it("does not launch when the old server rejects the restart", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const code = await runRunnerRestartCli(
      { ...base, build: false },
      {
        ...quiet,
        error: (m) => errors.push(m),
        callRestart: async () => ({ status: 401, body: { error: "unauthorized" } }),
        launch: () => calls.push("launch"),
      },
    );
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.match(errors[0], /HTTP 401 \(unauthorized\)/);
  });

  it("does not launch a second server while the old one still holds the port", async () => {
    const calls: string[] = [];
    const code = await runRunnerRestartCli(
      { ...base, build: false },
      {
        ...quiet,
        callRestart: async () => ({ status: 200, body: {} }),
        waitForPortFree: async () => false,
        launch: () => calls.push("launch"),
      },
    );
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
  });

  it("end to end over HTTP: SSE client open, old server exits, new one answers", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-restart-cli-"));
    const port = await reservePort();
    const config = cfg(dataDir, port);
    const servers: RunnerHttpServer[] = [];
    const boot = async () => {
      const engine = new RunnerEngine(config, { watchCi: false });
      await engine.init();
      const server = startHttpServer(config, engine, { onProcessExit: () => undefined });
      servers.push(server);
      await bindRunnerHttpServer(server, config.host, config.port);
    };
    await boot();
    const sse = await openSse(port, config.token);

    const order: string[] = [];
    const code = await runRunnerRestartCli(
      { build: true, entry: base.entry, host: "127.0.0.1", port, token: config.token },
      {
        ...quiet,
        build: async () => {
          order.push("build");
          // The old server must still be serving while the build runs.
          const meta = await httpRequest(port, "GET", "/api/jobs/meta", config.token);
          assert.equal(meta.status, 200);
        },
        launch: () => {
          order.push("launch");
          void boot();
        },
      },
    );
    await sse.ended;
    assert.equal(code, 0);
    assert.deepEqual(order, ["build", "launch"]);
    assert.equal(servers.length, 2);
    assert.equal(servers[0].listening, false);
    assert.equal((await httpRequest(port, "GET", "/api/jobs/meta", config.token)).status, 200);
    await servers[1].shutdown();

    const nothingListening = await runRunnerRestartCli(
      { build: false, entry: base.entry, host: "127.0.0.1", port: await reservePort(), token: "x" },
      { ...quiet, launch: () => undefined, waitForUp: async () => false },
    );
    assert.equal(nothingListening, 1, "nothing came up");
  });
});
