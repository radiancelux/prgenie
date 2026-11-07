import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { startHttpServer } from "./server.js";
import { archivedJobFile, archivedLogFile, jobFile, jobLogFile } from "./paths.js";
import { saveJob } from "./store.js";
import type { JobStage } from "./types.js";

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

async function seedJob(dataDir: string, id: string, stage: JobStage): Promise<void> {
  await mkdir(path.join(dataDir, "logs"), { recursive: true });
  await writeFile(jobLogFile(dataDir, id), `log ${id}\n`, "utf8");
  await saveJob(dataDir, {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: { repoPath: "/repo", branch: `b-${id}`, promptFile: "/p" },
    stage,
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: null,
    prNumber: null,
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
      assert.equal(again.status, 404);

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
