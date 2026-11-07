import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import { startHttpServer } from "./server.js";

const TOKEN = "test-token";

function makeConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

type EngineOverrides = Partial<{
  list: () => Promise<unknown>;
  jobsMeta: () => Promise<unknown>;
  startJob: (args: unknown) => Promise<unknown>;
  get: (jobId: string) => Promise<unknown>;
  steer: (jobId: string, prompt: string) => Promise<unknown>;
  stop: (jobId: string) => Promise<unknown>;
}>;

function fakeEngine(overrides: EngineOverrides = {}): RunnerEngine {
  const engine = {
    list: async () => [],
    jobsMeta: async () => ({ totalOnDisk: 0, mergedHidden: 0 }),
    startJob: async () => ({ id: "job-1" }),
    get: async () => null,
    steer: async () => null,
    stop: async () => null,
    on: () => engine,
    ...overrides,
  };
  return engine as unknown as RunnerEngine;
}

async function startTestServer(engine: RunnerEngine): Promise<{
  server: http.Server;
  base: string;
}> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-server-"));
  const server = startHttpServer(makeConfig(dataDir), engine);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(
  base: string,
  pathname: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("request error boundary", () => {
  it("returns a safe 500 when a handler rejects, then keeps serving", async () => {
    let calls = 0;
    const engine = fakeEngine({
      list: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom: leaked-secret-value");
        return [];
      },
    });
    const { server, base } = await startTestServer(engine);
    try {
      const failed = await request(base, "/api/jobs");
      assert.equal(failed.status, 500);
      const body = await failed.text();
      assert.equal(body, JSON.stringify({ error: "internal_error" }));
      assert.doesNotMatch(body, /leaked-secret-value/);

      const followUp = await request(base, "/api/jobs");
      assert.equal(followUp.status, 200);
      assert.deepEqual(await followUp.json(), []);
    } finally {
      await stopTestServer(server);
    }
  });

  it("returns a safe 500 when a handler throws synchronously, then keeps serving", async () => {
    let calls = 0;
    const engine = fakeEngine({
      jobsMeta: () => {
        calls += 1;
        if (calls === 1) throw new Error("sync boom");
        return Promise.resolve({ totalOnDisk: 0, mergedHidden: 0 });
      },
    });
    const { server, base } = await startTestServer(engine);
    try {
      const failed = await request(base, "/api/jobs/meta");
      assert.equal(failed.status, 500);
      assert.equal(await failed.text(), JSON.stringify({ error: "internal_error" }));

      const followUp = await request(base, "/api/jobs/meta");
      assert.equal(followUp.status, 200);
      assert.deepEqual(await followUp.json(), { totalOnDisk: 0, mergedHidden: 0 });
    } finally {
      await stopTestServer(server);
    }
  });

  it("rejects malformed JSON with a 4xx and keeps serving", async () => {
    const engine = fakeEngine();
    const { server, base } = await startTestServer(engine);
    try {
      const failed = await request(base, "/api/jobs", { method: "POST", body: "{not json" });
      assert.equal(failed.status, 400);
      assert.deepEqual(await failed.json(), { error: "invalid_payload" });

      const followUp = await request(base, "/api/jobs");
      assert.equal(followUp.status, 200);
    } finally {
      await stopTestServer(server);
    }
  });

  it("rejects valid JSON with an unexpected payload shape with a 4xx", async () => {
    const engine = fakeEngine();
    const { server, base } = await startTestServer(engine);
    try {
      const failed = await request(base, "/api/jobs", { method: "POST", body: "null" });
      assert.equal(failed.status, 400);
      assert.deepEqual(await failed.json(), { error: "invalid_payload" });

      const followUp = await request(base, "/api/jobs");
      assert.equal(followUp.status, 200);
    } finally {
      await stopTestServer(server);
    }
  });

  it("rejects oversized request bodies with a 4xx and keeps serving", async () => {
    const engine = fakeEngine();
    const { server, base } = await startTestServer(engine);
    try {
      const failed = await request(base, "/api/jobs", {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      });
      assert.equal(failed.status, 413);
      assert.deepEqual(await failed.json(), { error: "payload_too_large" });

      const followUp = await request(base, "/api/jobs");
      assert.equal(followUp.status, 200);
    } finally {
      await stopTestServer(server);
    }
  });

  it("does not double-respond after headers are sent", async () => {
    const engine = fakeEngine({
      get: async () => {
        throw new Error("rejected after headers");
      },
    });
    const { server, base } = await startTestServer(engine);
    try {
      const stream = await request(base, "/api/jobs/job-1/stream");
      assert.equal(stream.status, 200);
      await stream.text();

      const followUp = await request(base, "/api/jobs/meta");
      assert.equal(followUp.status, 200);
    } finally {
      await stopTestServer(server);
    }
  });
});
