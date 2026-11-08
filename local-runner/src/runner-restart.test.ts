import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { createJob, loadJob, saveJob } from "./store.js";
import { startHttpServer } from "./server.js";
import { saveSettings } from "./settings.js";
import { workerLooksAlive } from "./job-worker-monitor.js";
import { pidAlive } from "./pid-util.js";

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
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const bin = path.join(root, "local-runner/dist/runner.cjs");
  return {
    ...process.env,
    PRGENIE_RUNNER_BINARY: bin,
    PRGENIE_RUNNER_ROLE: "serve",
    PRGENIE_RUNNER_DETACHED_JOBS: "1",
    PRGENIE_RUNNER_SLOW_MS: "8000",
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
  fn: () => Promise<boolean>,
  label: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout: ${label}`);
}

describe("live runner restart (detached workers)", () => {
  const envBefore = { ...process.env };
  let dataDir = "";
  let port = 0;

  before(async () => {
    delete process.env.PRGENIE_RUNNER_INLINE_JOBS;
    Object.assign(process.env, workerLauncherEnv());
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-restart-"));
    port = await reservePort();
    process.env.PRGENIE_RUNNER_DATA_DIR = dataDir;
    process.env.PRGENIE_RUNNER_TOKEN = "restart-test-token";
    await saveSettings(dataDir, { maxActiveJobs: 4 });
  });

  after(() => {
    process.env = envBefore;
  });

  async function startJobAtStage(
    stage: "building" | "reviewing" | "fixing",
    reviewRound: number,
  ): Promise<string> {
    const job = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: `feat/restart-${stage}-${reviewRound}-${Date.now()}`,
        promptFile: "/p.md",
        maxRounds: 1,
        dryRun: true,
        driver: "slow-dry-run",
      },
      { model: "composer-2.5", dryRun: true, config: cfg(dataDir, port) },
    );
    job.driverId = "slow-dry-run";
    job.stage = stage;
    job.reviewRound = reviewRound;
    if (stage !== "building") {
      job.prUrl = "https://github.com/example/example/pull/1";
      job.prNumber = 1;
    }
    await saveJob(dataDir, job);
    return job.id;
  }

  for (const stage of ["building", "reviewing", "fixing"] as const) {
    it(`re-adopts a job in ${stage} across serve restart without duplicate workers`, async () => {
      const reviewRound = stage === "building" ? 0 : 1;
      const jobId = await startJobAtStage(stage, reviewRound);
      const config = cfg(dataDir, port);
      const engineA = new RunnerEngine(config, { watchCi: false });
      await engineA.init();

      await waitUntil(async () => {
        const j = await loadJob(dataDir, jobId);
        return Boolean(j?.worker?.pid && workerLooksAlive(j.worker));
      }, `worker alive (${stage})`);

      const firstWorkerPid = (await loadJob(dataDir, jobId))!.worker!.pid;
      assert.ok(pidAlive(firstWorkerPid));

      const logBefore = await readFile((await loadJob(dataDir, jobId))!.logPath, "utf8").catch(
        () => "",
      );

      const engineB = new RunnerEngine(config, { watchCi: false });
      await engineB.init();

      const mid = await loadJob(dataDir, jobId);
      assert.equal(mid?.worker?.pid, firstWorkerPid, "must not spawn a second worker");
      assert.ok(workerLooksAlive(mid?.worker));

      await waitUntil(async () => {
        const j = await loadJob(dataDir, jobId);
        return j?.stage === "approved";
      }, `job completes (${stage})`);

      const finalJob = await loadJob(dataDir, jobId);
      assert.equal(finalJob?.stage, "approved");
      const logAfter = await readFile(finalJob!.logPath, "utf8");
      assert.ok(logAfter.length >= logBefore.length, "log tail must remain intact");
      assert.match(logAfter, /slow agent/);
    });
  }

  it("marks orphaned active jobs interrupted when the worker is gone", async () => {
    const job = await createJob(
      dataDir,
      {
        repoPath: "/tmp/repo",
        branch: `feat/orphan-${Date.now()}`,
        promptFile: "/p.md",
        maxRounds: 1,
        dryRun: true,
      },
      { model: "composer-2.5", dryRun: true, config: cfg(dataDir, port) },
    );
    job.worker = { pid: 2_147_483_640, hostname: os.hostname(), startedAt: new Date().toISOString() };
    await saveJob(dataDir, job);

    const engine = new RunnerEngine(cfg(dataDir, port), { watchCi: false });
    await engine.init();
    const reloaded = await loadJob(dataDir, job.id);
    assert.equal(reloaded?.stage, "interrupted");
    assert.match(reloaded?.error ?? "", /Runner restart/);
  });

  it("POST /api/runner/restart returns adoption preview", async () => {
    const isoDir = await mkdtemp(path.join(os.tmpdir(), "lr-restart-http-"));
    const p = await reservePort();
    const config = cfg(isoDir, p);
    process.env.PRGENIE_RUNNER_ROLE = "serve";
    const engine = new RunnerEngine(config, { watchCi: false });
    await engine.init();
    let exiting = false;
    const server = startHttpServer(config, engine, {
      onGracefulShutdown: async () => {
        exiting = true;
        await new Promise<void>((r) => server.close(() => r()));
      },
      onProcessExit: () => undefined,
    });
    await new Promise<void>((r) => server.on("listening", () => r()));

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const payload = "{}";
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: p,
          path: "/api/runner/restart",
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
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
      req.write(payload);
      req.end();
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { ok: boolean; idle: boolean };
    assert.equal(body.ok, true);
    assert.equal(typeof body.idle, "boolean");
    await waitUntil(async () => exiting, "http shutdown");
  });
});
