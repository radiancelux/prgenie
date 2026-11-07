import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { startHttpServer } from "./server.js";

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
