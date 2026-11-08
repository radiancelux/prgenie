import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { handleContinueJobRequest, handleStartJobRequest, startHttpServer } from "./server.js";
import { handleMcpJsonRpc, handleRunnerTool } from "./mcp-handlers.js";
import { ValidationError } from "./settings-validation.js";
import { BranchConflictError } from "./job-queue.js";
import { archivedJobFile, archivedLogFile, jobFile, jobLogFile } from "./paths.js";
import { saveSettings } from "./settings.js";
import { saveJob } from "./store.js";
import type { JobRecord, JobStage } from "./types.js";

function cfg(dataDir: string, port: number): RunnerConfig {
  return {
    host: "127.0.0.1",
    port,
    token: "test-runner-token",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  opts: { token?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("startHttpServer hardening", () => {
  let dataDir = "";
  let port = 0;
  let server: http.Server;

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-http-"));
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    port = (s.address() as { port: number }).port;
    s.close();
    const engine = new RunnerEngine(cfg(dataDir, port));
    server = startHttpServer(cfg(dataDir, port), engine);
    await new Promise<void>((r) => server.on("listening", () => r()));
  });

  after(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("preserves 401 without token", async () => {
    const res = await httpRequest(port, "GET", "/api/jobs");
    assert.equal(res.status, 401);
    assert.match(res.body, /unauthorized/);
  });

  it("rejects invalid JSON on POST /api/jobs", async () => {
    const res = await httpRequest(port, "POST", "/api/jobs", {
      token: "test-runner-token",
      body: "{not-json",
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /invalid json/);
  });

  it("rejects array JSON on MCP", async () => {
    const res = await httpRequest(port, "POST", "/mcp", {
      token: "test-runner-token",
      body: "[]",
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /expected json object/);
  });

  it("rejects oversized body", async () => {
    const big = JSON.stringify({ branch: "x", pad: "z".repeat(2_000_000) });
    const res = await httpRequest(port, "POST", "/api/jobs", {
      token: "test-runner-token",
      body: big,
    });
    assert.equal(res.status, 413);
  });

  it("authenticated request succeeds after failures", async () => {
    await httpRequest(port, "POST", "/api/jobs", { token: "test-runner-token", body: "null" });
    const res = await httpRequest(port, "GET", "/api/jobs/meta", { token: "test-runner-token" });
    assert.equal(res.status, 200);
    const meta = JSON.parse(res.body) as { totalOnDisk: number };
    assert.ok(typeof meta.totalOnDisk === "number");
  });

  it("steer rejects non-string prompt type", async () => {
    const res = await httpRequest(port, "POST", "/api/jobs/nope/steer", {
      token: "test-runner-token",
      body: JSON.stringify({ prompt: 123 }),
    });
    assert.equal(res.status, 400);
  });
});

async function startTestServer(): Promise<{
  port: number;
  dataDir: string;
  close: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-http-archive-"));
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = startHttpServer(cfg(dataDir, port), new RunnerEngine(cfg(dataDir, port)));
  await new Promise<void>((r) => server.on("listening", () => r()));
  return {
    port,
    dataDir,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function seedJob(
  dataDir: string,
  id: string,
  stage: JobStage,
  opts: { prUrl?: string | null; branch?: string } = {},
): Promise<void> {
  await mkdir(path.join(dataDir, "logs"), { recursive: true });
  await writeFile(jobLogFile(dataDir, id), `log ${id}\n`, "utf8");
  const prUrl =
    opts.prUrl !== undefined
      ? opts.prUrl
      : stage === "building"
        ? null
        : "https://github.com/example/example/pull/1";
  await saveJob(dataDir, {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: { repoPath: "/repo", branch: opts.branch ?? `b-${id}`, promptFile: "/p" },
    stage,
    reviewRound: 2,
    maxRounds: 3,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl,
    prNumber: prUrl ? 1 : null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: id,
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: jobLogFile(dataDir, id),
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const TOKEN = "test-runner-token";

function mcpCall(port: number, name: string, args: Record<string, unknown>) {
  return httpRequest(port, "POST", "/mcp", {
    token: TOKEN,
    body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } }),
  }).then(
    (r) =>
      JSON.parse(r.body) as {
        result?: { structuredContent: Record<string, unknown> };
        error?: { message: string };
      },
  );
}

describe("job archive over HTTP and MCP", () => {
  it("requires the bearer token like stop/steer", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "failed");
      for (const p of [
        "/api/jobs/job-1/archive",
        "/api/jobs/job-1/restore",
        "/api/jobs/clear-failed",
      ]) {
        assert.equal((await httpRequest(s.port, "POST", p)).status, 401, p);
      }
      assert.equal((await httpRequest(s.port, "GET", "/api/events")).status, 401);
      assert.equal(await fileExists(jobFile(s.dataDir, "job-1")), true);
    } finally {
      await s.close();
    }
  });

  it("archives and restores a terminal job (files move under archived/ and back)", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "approved");
      const res = await httpRequest(s.port, "POST", "/api/jobs/job-1/archive", { token: TOKEN });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as { ok: boolean; worktree: string; archivedAt: string };
      assert.equal(body.ok, true);
      assert.equal(body.worktree, "none");
      assert.equal(await fileExists(archivedJobFile(s.dataDir, "job-1")), true);
      assert.equal(await fileExists(archivedLogFile(s.dataDir, "job-1")), true);
      assert.equal(await fileExists(jobFile(s.dataDir, "job-1")), false);

      const live = await httpRequest(s.port, "GET", "/api/jobs", { token: TOKEN });
      assert.deepEqual(JSON.parse(live.body), []);
      const all = await httpRequest(s.port, "GET", "/api/jobs?includeArchived=1", { token: TOKEN });
      const listed = JSON.parse(all.body) as Array<{ id: string; archivedAt: string | null }>;
      assert.deepEqual(
        listed.map((j) => j.id),
        ["job-1"],
      );
      assert.ok(listed[0].archivedAt);
      const meta = await httpRequest(s.port, "GET", "/api/jobs/meta", { token: TOKEN });
      assert.equal((JSON.parse(meta.body) as { archived: number }).archived, 1);
      const detail = await httpRequest(s.port, "GET", "/api/jobs/job-1", { token: TOKEN });
      assert.equal(detail.status, 200, "archived job transcript stays readable");
      assert.match(detail.body, /log job-1/);

      const again = await httpRequest(s.port, "POST", "/api/jobs/job-1/archive", { token: TOKEN });
      assert.equal(again.status, 200, "re-archive is idempotent");
      assert.equal((JSON.parse(again.body) as { ok: boolean }).ok, true);

      const restored = await httpRequest(s.port, "POST", "/api/jobs/job-1/restore", {
        token: TOKEN,
      });
      assert.equal(restored.status, 200);
      assert.equal(await fileExists(jobFile(s.dataDir, "job-1")), true);
      assert.equal(await fileExists(jobLogFile(s.dataDir, "job-1")), true);
      assert.equal(await fileExists(archivedJobFile(s.dataDir, "job-1")), false);
    } finally {
      await s.close();
    }
  });

  it("rejects archiving a running job with 409 over HTTP and an error over MCP", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-run", "building");
      const res = await httpRequest(s.port, "POST", "/api/jobs/job-run/archive", { token: TOKEN });
      assert.equal(res.status, 409);
      assert.deepEqual(JSON.parse(res.body), {
        error: "job is still running (building); stop it before removing",
        stage: "building",
      });
      const mcp = await mcpCall(s.port, "archive_job", { id: "job-run" });
      assert.match(mcp.error?.message ?? "", /still running \(building\)/);
      assert.equal(await fileExists(jobFile(s.dataDir, "job-run")), true);
      assert.equal(await fileExists(archivedJobFile(s.dataDir, "job-run")), false);
    } finally {
      await s.close();
    }
  });

  it("MCP archive_job / restore_job / list_jobs includeArchived", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "failed");
      const tools = await httpRequest(s.port, "POST", "/mcp", {
        token: TOKEN,
        body: JSON.stringify({ id: 1, method: "tools/list" }),
      });
      const names = (
        JSON.parse(tools.body) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      assert.ok(names.includes("archive_job") && names.includes("restore_job"));

      const archived = await mcpCall(s.port, "archive_job", { id: "job-1" });
      assert.equal(archived.result?.structuredContent.ok, true);
      assert.equal(await fileExists(archivedJobFile(s.dataDir, "job-1")), true);
      const listed = await mcpCall(s.port, "list_jobs", { includeArchived: true });
      assert.equal((listed.result?.structuredContent as unknown as unknown[]).length, 1);
      const liveOnly = await mcpCall(s.port, "list_jobs", {});
      assert.equal((liveOnly.result?.structuredContent as unknown as unknown[]).length, 0);

      const restored = await mcpCall(s.port, "restore_job", { id: "job-1" });
      assert.equal(restored.result?.structuredContent.ok, true);
      assert.equal(await fileExists(jobFile(s.dataDir, "job-1")), true);

      const bad = await mcpCall(s.port, "archive_job", { id: "../settings" });
      assert.match(bad.error?.message ?? "", /invalid job id/);
    } finally {
      await s.close();
    }
  });

  it("rejects a traversal id and a restore collision", async () => {
    const s = await startTestServer();
    try {
      const bad = await httpRequest(s.port, "POST", "/api/jobs/..%2Fsettings/archive", {
        token: TOKEN,
      });
      assert.equal(bad.status, 400);
      await seedJob(s.dataDir, "job-1", "stopped");
      await httpRequest(s.port, "POST", "/api/jobs/job-1/archive", { token: TOKEN });
      await seedJob(s.dataDir, "job-1", "failed");
      const res = await httpRequest(s.port, "POST", "/api/jobs/job-1/restore", { token: TOKEN });
      assert.equal(res.status, 409);
      assert.match(res.body, /already exists/);
    } finally {
      await s.close();
    }
  });

  it("clear-failed archives failed jobs, plus stuck/stopped when asked", async () => {
    const s = await startTestServer();
    try {
      for (const stage of ["failed", "stuck", "stopped", "approved", "building"] as JobStage[]) {
        await seedJob(s.dataDir, `job-${stage}`, stage);
      }
      const bad = await httpRequest(s.port, "POST", "/api/jobs/clear-failed", {
        token: TOKEN,
        body: JSON.stringify({ includeStuckStopped: "yes" }),
      });
      assert.equal(bad.status, 400);

      const first = await httpRequest(s.port, "POST", "/api/jobs/clear-failed", { token: TOKEN });
      assert.equal(first.status, 200);
      assert.deepEqual((JSON.parse(first.body) as { archived: string[] }).archived, ["job-failed"]);

      const second = await httpRequest(s.port, "POST", "/api/jobs/clear-failed", {
        token: TOKEN,
        body: JSON.stringify({ includeStuckStopped: true }),
      });
      const archived = (JSON.parse(second.body) as { archived: string[] }).archived;
      assert.deepEqual([...archived].sort(), ["job-stopped", "job-stuck"]);
      const live = JSON.parse(
        (await httpRequest(s.port, "GET", "/api/jobs", { token: TOKEN })).body,
      ) as Array<{ id: string }>;
      assert.deepEqual(live.map((j) => j.id).sort(), ["job-approved", "job-building"]);
    } finally {
      await s.close();
    }
  });

  it("pushes a list update on /api/events when a job is archived or restored", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "failed");
      const chunks: string[] = [];
      const req = http.get({
        hostname: "127.0.0.1",
        port: s.port,
        path: `/api/events?token=${TOKEN}`,
      });
      const connected = new Promise<void>((resolve) => {
        req.on("response", (res) => {
          assert.equal(res.headers["content-type"], "text/event-stream");
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            chunks.push(c);
            resolve();
          });
        });
      });
      req.on("error", () => {});
      await connected;
      const events = () => chunks.join("").match(/data: \{"type":"jobs"\}/g)?.length ?? 0;

      await httpRequest(s.port, "POST", "/api/jobs/job-1/archive", { token: TOKEN });
      for (let i = 0; i < 40 && events() < 1; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(events(), 1);
      await httpRequest(s.port, "POST", "/api/jobs/job-1/restore", { token: TOKEN });
      for (let i = 0; i < 40 && events() < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(events(), 2);
      req.destroy();
    } finally {
      await s.close();
    }
  });
});

describe("PATCH /api/settings validation", () => {
  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["defaultMaxRounds 0", { defaultMaxRounds: 0 }, "maxRounds must be between 1 and 10"],
    ["defaultMaxRounds 11", { defaultMaxRounds: 11 }, "maxRounds must be between 1 and 10"],
    ["defaultMaxRounds string", { defaultMaxRounds: "x" }, "maxRounds must be a finite number"],
    ["defaultMaxRounds null", { defaultMaxRounds: null }, "maxRounds must be a finite number"],
    ["maxActiveJobs -1", { maxActiveJobs: -1 }, "maxActiveJobs must be between 1 and 8"],
    ["maxActiveJobs 9", { maxActiveJobs: 9 }, "maxActiveJobs must be between 1 and 8"],
    ["maxActiveJobs string", { maxActiveJobs: "2" }, "maxActiveJobs must be a finite number"],
    ["watchdog not object", { watchdog: 5 }, "watchdog must be an object"],
    [
      "watchdog.inactivityMs low",
      { watchdog: { inactivityMs: 1_000 } },
      "watchdog.inactivityMs must be between 60000 and 3600000",
    ],
    [
      "watchdog.stageCapMs string",
      { watchdog: { stageCapMs: "big" } },
      "watchdog.stageCapMs must be a finite number",
    ],
    [
      "watchdog.stageCapMs high",
      { watchdog: { stageCapMs: 9 * 60 * 60 * 1000 } },
      "watchdog.stageCapMs must be between 300000 and 28800000",
    ],
    [
      "watchdog.recoveryAttempts 4",
      { watchdog: { recoveryAttempts: 4 } },
      "watchdog.recoveryAttempts must be between 0 and 3",
    ],
    [
      "watchdog.recoveryAttempts -1",
      { watchdog: { recoveryAttempts: -1 } },
      "watchdog.recoveryAttempts must be between 0 and 3",
    ],
    ["stageModels not object", { stageModels: "fast" }, "stageModels must be an object"],
    [
      "stageModels.build number",
      { stageModels: { build: 3 } },
      "stageModels.build must be a string or null",
    ],
    [
      "notifyEvents.onFailed string",
      { notifyEvents: { onFailed: "yes" } },
      "notifyEvents.onFailed must be a boolean",
    ],
    [
      "expectedRevision string",
      { expectedRevision: "1" },
      "expectedRevision must be a non-negative integer",
    ],
    [
      "jobTypes.compute.watchdog low inactivity",
      {
        jobTypes: { compute: { watchdog: { inactivityMs: 1_000 } } },
      },
      "watchdog.inactivityMs must be between 60000 and 3600000",
    ],
    ["jobTypes not object", { jobTypes: "docs" }, "jobTypes must be an object"],
  ];

  it("returns 400 with the validation message for each invalid field", async () => {
    const s = await startTestServer();
    try {
      const before = await httpRequest(s.port, "GET", "/api/settings", { token: TOKEN });
      for (const [label, body, message] of invalid) {
        const res = await httpRequest(s.port, "PATCH", "/api/settings", {
          token: TOKEN,
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 400, label);
        assert.deepEqual(JSON.parse(res.body), { error: message }, label);
      }
      const after = await httpRequest(s.port, "GET", "/api/settings", { token: TOKEN });
      assert.deepEqual(JSON.parse(after.body), JSON.parse(before.body), "nothing persisted");
    } finally {
      await s.close();
    }
  });

  it("GET /setup serves runner policy form (#145)", async () => {
    const s = await startTestServer();
    try {
      const res = await httpRequest(s.port, "GET", "/setup");
      assert.equal(res.status, 200);
      assert.match(res.body, /id="defaultMaxRounds"/);
      assert.match(res.body, /id="computeWatchdogStageCapMs"/);
      assert.match(res.body, /your-org\/your-docs-repo/);
    } finally {
      await s.close();
    }
  });

  it("round-trips a valid PATCH", async () => {
    const s = await startTestServer();
    try {
      const res = await httpRequest(s.port, "PATCH", "/api/settings", {
        token: TOKEN,
        body: JSON.stringify({
          defaultMaxRounds: 5,
          maxActiveJobs: 4,
          watchdog: { inactivityMs: 120_000, recoveryAttempts: 2 },
          stageModels: { review: "review-model" },
          notifyEvents: { onStuck: false },
          jobTypes: {
            compute: {
              watchdog: { inactivityMs: 180_000, stageCapMs: 7_200_000, recoveryAttempts: 0 },
            },
          },
        }),
      });
      assert.equal(res.status, 200);
      const got = JSON.parse(
        (await httpRequest(s.port, "GET", "/api/settings", { token: TOKEN })).body,
      ) as {
        defaultMaxRounds: number;
        maxActiveJobs: number;
        watchdog: { inactivityMs: number; stageCapMs: number; recoveryAttempts: number };
        stageModels: { review: string | null };
        notifyEvents: { onStuck: boolean; onFailed: boolean };
        settingsRevision: number;
      };
      assert.equal(got.defaultMaxRounds, 5);
      assert.equal(got.maxActiveJobs, 4);
      assert.deepEqual(got.watchdog, {
        inactivityMs: 120_000,
        stageCapMs: 120 * 60 * 1000,
        recoveryAttempts: 2,
      });
      assert.equal(got.stageModels.review, "review-model");
      assert.equal(got.notifyEvents.onStuck, false);
      assert.equal(got.notifyEvents.onFailed, true);
      const computeWd = (
        got as { jobTypes?: { compute?: { watchdog?: { inactivityMs: number } } } }
      ).jobTypes?.compute?.watchdog;
      assert.equal(computeWd?.inactivityMs, 180_000);

      const stale = await httpRequest(s.port, "PATCH", "/api/settings", {
        token: TOKEN,
        body: JSON.stringify({ expectedRevision: got.settingsRevision - 1, maxActiveJobs: 3 }),
      });
      assert.equal(stale.status, 409);
      assert.match(stale.body, /settings changed on disk/);
    } finally {
      await s.close();
    }
  });

  it("still rejects malformed JSON with 400", async () => {
    const s = await startTestServer();
    try {
      const res = await httpRequest(s.port, "PATCH", "/api/settings", {
        token: TOKEN,
        body: "{not-json",
      });
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), { error: "invalid json" });
    } finally {
      await s.close();
    }
  });
});

describe("start job validation parity (HTTP POST /api/jobs vs MCP start_job)", () => {
  const base = { branch: "feat/parity", promptFile: "/prompt.md", repoPath: "/repo" };
  const DRIVER_MSG = /^driver must be a registered built-in id \(/;
  const cases: Array<[string, Record<string, unknown>, string | RegExp]> = [
    ["empty payload", {}, "branch is required"],
    ["missing branch", { promptFile: "/prompt.md", repoPath: "/repo" }, "branch is required"],
    ["blank branch", { ...base, branch: "   " }, "branch is required"],
    ["non-string branch", { ...base, branch: 7 }, "branch must be a string"],
    [
      "missing promptFile",
      { branch: "feat/parity", repoPath: "/repo" },
      "promptFile is required for code and compute jobs",
    ],
    [
      "missing repo",
      { branch: "feat/parity", promptFile: "/prompt.md" },
      "repoPath or remote required (or configure a code default repo in Setup)",
    ],
    ["non-string repoPath", { ...base, repoPath: 42 }, "repoPath must be a string"],
    ["maxRounds 0", { ...base, maxRounds: 0 }, "maxRounds must be between 1 and 10"],
    ["maxRounds 11", { ...base, maxRounds: 11 }, "maxRounds must be between 1 and 10"],
    ["maxRounds -3", { ...base, maxRounds: -3 }, "maxRounds must be between 1 and 10"],
    ['maxRounds "3"', { ...base, maxRounds: "3" }, "maxRounds must be a finite number"],
    ["maxRounds NaN", { ...base, maxRounds: Number.NaN }, "maxRounds must be a finite number"],
    [
      "maxRounds Infinity",
      { ...base, maxRounds: Number.POSITIVE_INFINITY },
      "maxRounds must be a finite number",
    ],
    ["unknown driver", { ...base, driver: "nope" }, DRIVER_MSG],
    ["non-string driver", { ...base, driver: 5 }, DRIVER_MSG],
    ["bad jobType", { ...base, jobType: "ops" }, "jobType must be one of: code, docs, compute"],
    ["bad profile", { ...base, profile: "ops" }, "profile must be one of: code, docs, compute"],
    [
      "bad docsTemplate",
      { ...base, jobType: "docs", docsTemplate: "blog" },
      "docsTemplate must be one of: marketing, policy, research",
    ],
    [
      "docs job without template or prompt",
      { branch: "docs/x", repoPath: "/repo", jobType: "docs" },
      "docs jobs need docsTemplate or promptFile",
    ],
    ["non-boolean dryRun", { ...base, dryRun: "yes" }, "dryRun must be a boolean"],
    ["non-object stageModels", { ...base, stageModels: "fast" }, "stageModels must be an object"],
    [
      "non-string stage model",
      { ...base, stageModels: { review: 1 } },
      "stageModels.review must be a string",
    ],
    [
      "non-array ticketUrls",
      { ...base, ticketUrls: "https://example.com/1" },
      "ticketUrls must be an array of strings",
    ],
    [
      "non-http ticketUrls",
      { ...base, ticketUrls: ["javascript:alert(1)"] },
      "ticketUrls entries must be http(s) URLs",
    ],
    [
      "too many ticketUrls",
      { ...base, ticketUrls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`) },
      "ticketUrls allows at most 10 entries",
    ],
  ];

  function assertMessage(actual: string, expected: string | RegExp, label: string): void {
    if (typeof expected === "string") assert.equal(actual, expected, label);
    else assert.match(actual, expected, label);
  }

  it("rejects each bad payload with the same message over the HTTP and MCP handlers", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-parity-"));
    const engine = new RunnerEngine(cfg(dataDir, 0));
    for (const [label, payload, expected] of cases) {
      const httpReply = await handleStartJobRequest(engine, { ...payload });
      const mcp = await handleMcpJsonRpc(engine, {
        id: 1,
        method: "tools/call",
        params: { name: "start_job", arguments: { ...payload } },
      });
      assert.equal(httpReply.status, 400, label);
      const httpMsg = (httpReply.body as { error: string }).error;
      assertMessage(httpMsg, expected, `${label} (http)`);
      assert.equal(mcp?.error?.message, httpMsg, `${label} (mcp matches http)`);
    }
    assert.deepEqual(await engine.list({ includeFinished: true }), [], "no job was created");
  });

  it("returns identical errors over the wire (HTTP 400 vs MCP error)", async () => {
    const s = await startTestServer();
    try {
      for (const [label, payload, expected] of cases) {
        // JSON cannot carry NaN/Infinity; the 1e999 request below covers that over the wire.
        if (Object.values(payload).some((v) => typeof v === "number" && !Number.isFinite(v))) {
          continue;
        }
        const body = JSON.stringify(payload);
        const res = await httpRequest(s.port, "POST", "/api/jobs", { token: TOKEN, body });
        assert.equal(res.status, 400, label);
        const httpMsg = (JSON.parse(res.body) as { error: string }).error;
        assertMessage(httpMsg, expected, `${label} (http)`);
        const mcp = await mcpCall(s.port, "start_job", payload);
        assert.equal(mcp.error?.message, httpMsg, `${label} (mcp matches http)`);
      }
      const inf = await httpRequest(s.port, "POST", "/api/jobs", {
        token: TOKEN,
        body: '{"branch":"feat/parity","promptFile":"/prompt.md","repoPath":"/repo","maxRounds":1e999}',
      });
      assert.equal(inf.status, 400);
      assert.deepEqual(JSON.parse(inf.body), { error: "maxRounds must be a finite number" });

      const meta = await httpRequest(s.port, "GET", "/api/jobs/meta", { token: TOKEN });
      assert.equal((JSON.parse(meta.body) as { totalOnDisk: number }).totalOnDisk, 0);
    } finally {
      await s.close();
    }
  });

  it("hands both paths the same normalized args for a valid payload", async () => {
    const captured: unknown[] = [];
    const engine = {
      startJob: async (args: unknown) => {
        captured.push(args);
        return { id: "x" } as unknown;
      },
    } as unknown as RunnerEngine;
    const payload = { ...base, branch: "  feat/parity  ", maxRounds: 10, driver: "claude-code" };
    const httpReply = await handleStartJobRequest(engine, { ...payload });
    await handleRunnerTool(engine, "start_job", { ...payload });
    assert.equal(httpReply.status, 201);
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[0], captured[1]);
    assert.equal((captured[0] as { branch: string }).branch, "feat/parity");
    assert.equal((captured[0] as { maxRounds: number }).maxRounds, 10);
  });

  it("stores the same stage models for HTTP and MCP starts (#146)", async () => {
    const s = await startTestServer();
    try {
      await saveSettings(s.dataDir, { maxActiveJobs: 1 });
      await seedJob(s.dataDir, "occupies-slot", "building");
      const repoPath = await mkdtemp(path.join(os.tmpdir(), "lr-parity-models-repo-"));
      const requests: Array<[string, Record<string, unknown>, Record<string, string>]> = [
        [
          "explicit fix beats legacy model",
          { model: "composer-2.5", stageModels: { review: "review-x", fix: "auto" } },
          { build: "composer-2.5", review: "review-x", fix: "auto" },
        ],
        ["no fix model given", {}, { build: "composer-2.5", review: "composer-2.5", fix: "auto" }],
        [
          "explicit non-auto fix",
          { stageModels: { fix: "fix-x" } },
          { build: "composer-2.5", review: "composer-2.5", fix: "fix-x" },
        ],
      ];
      for (const [i, [label, extra, expected]] of requests.entries()) {
        const payload = { ...base, repoPath, ...extra };
        const res = await httpRequest(s.port, "POST", "/api/jobs", {
          token: TOKEN,
          body: JSON.stringify({ ...payload, branch: `feat/http-${i}` }),
        });
        assert.equal(res.status, 201, label);
        const viaHttp = JSON.parse(res.body) as JobRecord;
        const mcp = await mcpCall(s.port, "start_job", { ...payload, branch: `feat/mcp-${i}` });
        const viaMcp = mcp.result?.structuredContent as unknown as JobRecord;
        assert.ok(viaMcp, `${label}: ${mcp.error?.message ?? ""}`);
        for (const job of [viaHttp, viaMcp]) {
          const stored = JSON.parse(
            await readFile(jobFile(s.dataDir, job.id), "utf8"),
          ) as JobRecord;
          assert.deepEqual(stored.stageModels, expected, label);
          assert.deepEqual(stored.effectiveSnapshot?.stageModels, expected, label);
          assert.equal(stored.queueState?.queued, true, `${label}: job must not run in tests`);
        }
      }
    } finally {
      await s.close();
    }
  });

  it("maps branch conflicts to 409 and internal start failures to 500", async () => {
    const conflict = await handleStartJobRequest(
      {
        startJob: async () => {
          throw new BranchConflictError("another active job is already using branch feat/x");
        },
      } as unknown as RunnerEngine,
      { ...base },
    );
    assert.equal(conflict.status, 409);
    const internal = await handleStartJobRequest(
      {
        startJob: async () => {
          throw new Error("EACCES: permission denied");
        },
      } as unknown as RunnerEngine,
      { ...base },
    );
    assert.equal(internal.status, 500);
  });

  it("engine.startJob enforces the same bounds for direct callers", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-parity-engine-"));
    const engine = new RunnerEngine(cfg(dataDir, 0));
    await assert.rejects(
      engine.startJob({ ...base, maxRounds: 0 }),
      (err: Error) => err instanceof ValidationError && /between 1 and 10/.test(err.message),
    );
  });
});

describe("continue job over HTTP and MCP", () => {
  const TOKEN = "test-runner-token";

  it("requires bearer auth like steer/stop", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "approved");
      const res = await httpRequest(s.port, "POST", "/api/jobs/job-1/continue");
      assert.equal(res.status, 401);
    } finally {
      await s.close();
    }
  });

  it("continues each allowed terminal stage and refuses running/archived", async () => {
    const s = await startTestServer();
    try {
      for (const stage of [
        "approved",
        "changes_remaining",
        "stuck",
        "stopped",
        "failed",
      ] as const) {
        const id = `job-${stage}`;
        await seedJob(s.dataDir, id, stage);
        const res = await httpRequest(s.port, "POST", `/api/jobs/${id}/continue`, {
          token: TOKEN,
          body: JSON.stringify({ prompt: "more work", extraRounds: 1 }),
        });
        assert.equal(res.status, 200, stage);
        const body = JSON.parse(res.body) as { ok: boolean; maxRounds: number; stage: string };
        assert.equal(body.ok, true);
        assert.equal(body.maxRounds, 4);
        assert.equal(body.stage, "fixing");
      }

      await seedJob(s.dataDir, "job-running", "building");
      const running = await httpRequest(s.port, "POST", "/api/jobs/job-running/continue", {
        token: TOKEN,
        body: "{}",
      });
      assert.equal(running.status, 409);

      await seedJob(s.dataDir, "job-arch", "approved");
      await httpRequest(s.port, "POST", "/api/jobs/job-arch/archive", { token: TOKEN });
      const archived = await httpRequest(s.port, "POST", "/api/jobs/job-arch/continue", {
        token: TOKEN,
        body: "{}",
      });
      assert.equal(archived.status, 409);
      assert.match(archived.body, /archived/i);
    } finally {
      await s.close();
    }
  });

  it("continues stuck/failed/stopped jobs without a PR by resuming build (HTTP/MCP parity)", async () => {
    const s = await startTestServer();
    try {
      for (const stage of ["stuck", "failed", "stopped"] as const) {
        const httpId = `job-${stage}-nopr-http`;
        await seedJob(s.dataDir, httpId, stage, { prUrl: null });
        const http = await httpRequest(s.port, "POST", `/api/jobs/${httpId}/continue`, {
          token: TOKEN,
          body: JSON.stringify({ prompt: "open a PR" }),
        });
        assert.equal(http.status, 200, stage);
        const body = JSON.parse(http.body) as { stage: string; maxRounds: number };
        assert.equal(body.stage, "building", stage);
        assert.equal(body.maxRounds, 3, "build resume spends no extra rounds by default");

        const mcpId = `job-${stage}-nopr-mcp`;
        await seedJob(s.dataDir, mcpId, stage, { prUrl: null });
        const mcp = await mcpCall(s.port, "continue_job", { id: mcpId, prompt: "mcp" });
        assert.equal((mcp.result?.structuredContent as { stage: string })?.stage, "building");
      }
    } finally {
      await s.close();
    }
  });

  it("rejects branch conflict with 409", async () => {
    const s = await startTestServer();
    try {
      const branch = "feat/shared";
      await seedJob(s.dataDir, "job-done", "approved", { branch });
      await seedJob(s.dataDir, "job-active", "fixing", { branch });
      const res = await httpRequest(s.port, "POST", "/api/jobs/job-done/continue", {
        token: TOKEN,
        body: "{}",
      });
      assert.equal(res.status, 409);
      assert.match(res.body, /another active job/i);
    } finally {
      await s.close();
    }
  });

  it("returns the same validation errors over HTTP and MCP", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "approved");
      const badCases: Array<{ payload: Record<string, unknown>; message: string }> = [
        { payload: { extraRounds: 0 }, message: "extraRounds must be between 1 and 10" },
        { payload: { extraRounds: 11 }, message: "extraRounds must be between 1 and 10" },
        { payload: { extraRounds: 9 }, message: "maxRounds would exceed 10 (3 + 9)" },
      ];
      for (const { payload, message } of badCases) {
        const body = JSON.stringify(payload);
        const http = await httpRequest(s.port, "POST", "/api/jobs/job-1/continue", {
          token: TOKEN,
          body,
        });
        assert.equal(http.status, 400, message);
        assert.deepEqual(JSON.parse(http.body), { error: message });
        const mcp = await mcpCall(s.port, "continue_job", { id: "job-1", ...payload });
        assert.match(
          mcp.error?.message ?? "",
          new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      }
    } finally {
      await s.close();
    }
  });

  it("MCP continue_job mirrors HTTP success payload", async () => {
    const s = await startTestServer();
    try {
      await seedJob(s.dataDir, "job-1", "approved");
      const mcp = await mcpCall(s.port, "continue_job", {
        id: "job-1",
        prompt: "fix CI",
        extraRounds: 1,
      });
      assert.equal(mcp.result?.structuredContent.ok, true);
      assert.equal((mcp.result?.structuredContent as { maxRounds: number }).maxRounds, 4);
    } finally {
      await s.close();
    }
  });

  it("handleContinueJobRequest normalizes id from URL", async () => {
    const captured: unknown[] = [];
    const engine = {
      continueJob: async (args: unknown) => {
        captured.push(args);
        return {
          ok: true,
          id: "job-1",
          stage: "fixing",
          maxRounds: 4,
          reviewRound: 3,
          worktree: "none",
          queued: false,
        };
      },
    } as unknown as RunnerEngine;
    await handleContinueJobRequest(engine, "job-1", { prompt: "x" });
    assert.deepEqual(captured[0], { prompt: "x", id: "job-1" });
  });
});
