import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import {
  handleMcpJsonRpc,
  MCP_PROTOCOL_VERSION,
  RUNNER_MCP_TOOL_NAMES,
  type JsonRpcResponse,
} from "./mcp-handlers.js";
import { MCP_STDIO_READY, serveMcpStdio } from "./mcp-stdio.js";
import { ensureDataDirs } from "./store.js";

type Wire = Record<string, unknown>;

function cfg(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "test",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

/** JSON-RPC 2.0 §5: exactly one of result/error, `jsonrpc: "2.0"`, and the request id echoed verbatim. */
function assertResponse(msg: Wire | undefined, id: string | number | null): asserts msg is Wire {
  assert.ok(msg, `missing response for id ${JSON.stringify(id)}`);
  assert.equal(msg.jsonrpc, "2.0", `jsonrpc on ${JSON.stringify(msg)}`);
  assert.ok("id" in msg, `id key present on ${JSON.stringify(msg)}`);
  assert.equal(msg.id, id);
  assert.equal(typeof msg.id, id === null ? "object" : typeof id, "id type preserved");
  assert.notEqual("result" in msg, "error" in msg, "exactly one of result / error");
  if ("error" in msg) {
    const err = msg.error as { code?: unknown; message?: unknown };
    assert.equal(typeof err.code, "number");
    assert.ok(Number.isInteger(err.code));
    assert.equal(typeof err.message, "string");
  }
}

function assertInitializeResult(msg: Wire): void {
  const result = msg.result as {
    protocolVersion?: unknown;
    capabilities?: { tools?: unknown };
    serverInfo?: { name?: unknown; version?: unknown };
  };
  assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(typeof result.capabilities?.tools, "object");
  assert.equal(result.serverInfo?.name, "prgenie");
  assert.match(String(result.serverInfo?.version), /^\d+\.\d+\.\d+/);
}

function assertToolsListResult(msg: Wire): void {
  const tools = (msg.result as { tools?: unknown }).tools as Wire[];
  assert.ok(Array.isArray(tools));
  assert.deepEqual(
    tools.map((t) => t.name),
    RUNNER_MCP_TOOL_NAMES,
  );
  for (const name of ["start_job", "continue_job", "settings"]) {
    assert.ok(RUNNER_MCP_TOOL_NAMES.includes(name as never), `${name} listed`);
  }
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    const schema = tool.inputSchema as { type?: unknown; properties?: unknown };
    assert.equal(schema.type, "object", `${String(tool.name)} inputSchema.type`);
    assert.equal(typeof schema.properties, "object");
  }
}

function assertToolCallResult(msg: Wire): string {
  const result = msg.result as { content?: unknown; structuredContent?: { id?: unknown } };
  assert.ok(Array.isArray(result.content) && result.content.length > 0);
  for (const block of result.content as Wire[]) {
    assert.equal(block.type, "text");
    assert.equal(typeof block.text, "string");
  }
  const text = (result.content as { text: string }[])[0].text;
  const parsed = JSON.parse(text) as { id?: unknown };
  assert.equal(typeof parsed.id, "string");
  assert.equal(result.structuredContent?.id, parsed.id);
  return parsed.id as string;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "prgenie-test", version: "0.0.0" },
  },
};

function startJobCall(id: string | number, repoPath: string, promptFile: string): Wire {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "start_job",
      arguments: {
        branch: "chore/mcp-protocol-dry-run",
        promptFile,
        repoPath,
        dryRun: true,
        maxRounds: 1,
      },
    },
  };
}

const execFileAsync = promisify(execFile);

async function smokeGitRepo(): Promise<{ repoPath: string; promptFile: string }> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-protocol-repo-"));
  await execFileAsync("git", ["-C", repoPath, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"]);
  const promptFile = path.join(repoPath, "README.md");
  await writeFile(promptFile, "# smoke\n", "utf8");
  return { repoPath, promptFile };
}

describe("MCP JSON-RPC envelope (handleMcpJsonRpc)", () => {
  async function engine(): Promise<RunnerEngine> {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-env-"));
    await ensureDataDirs(dataDir);
    const e = new RunnerEngine(cfg(dataDir), { watchCi: false });
    await e.init();
    return e;
  }

  it("echoes numeric, string, and zero ids with jsonrpc 2.0", async () => {
    const e = await engine();
    for (const id of [0, 7, "abc-123", ""]) {
      assertResponse(
        (await handleMcpJsonRpc(e, { jsonrpc: "2.0", id, method: "ping" })) as Wire,
        id,
      );
    }
  });

  it("answers ping with an empty result", async () => {
    const e = await engine();
    const res = await handleMcpJsonRpc(e, { jsonrpc: "2.0", id: 5, method: "ping" });
    assertResponse(res as Wire, 5);
    assert.deepEqual(res?.result, {});
  });

  it("never replies to notifications", async () => {
    const e = await engine();
    for (const method of ["notifications/initialized", "notifications/cancelled", "tools/list"]) {
      assert.equal(await handleMcpJsonRpc(e, { jsonrpc: "2.0", method }), null, method);
    }
  });

  it("maps protocol errors to JSON-RPC codes with the request id", async () => {
    const e = await engine();
    const cases: [unknown, string | number | null, number][] = [
      [{ jsonrpc: "2.0", id: 1, method: "nope/method" }, 1, -32601],
      [
        { jsonrpc: "2.0", id: "u", method: "tools/call", params: { name: "no_such_tool" } },
        "u",
        -32602,
      ],
      [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "constructor" } }, 2, -32602],
      [{ jsonrpc: "2.0", id: 3 }, 3, -32600],
      [{ jsonrpc: "2.0", id: null, method: "ping" }, null, -32600],
      [{ jsonrpc: "2.0", id: { nested: true }, method: "ping" }, null, -32600],
      [[], null, -32600],
    ];
    for (const [msg, id, code] of cases) {
      const res = (await handleMcpJsonRpc(e, msg)) as JsonRpcResponse;
      assertResponse(res as unknown as Wire, id);
      assert.equal(res.error?.code, code, JSON.stringify(msg));
    }
  });

  it("reports tool failures as JSON-RPC errors carrying the request id", async () => {
    const e = await engine();
    const res = await handleMcpJsonRpc(e, {
      jsonrpc: "2.0",
      id: "get-missing",
      method: "tools/call",
      params: { name: "get_job", arguments: { id: "missing" } },
    });
    assertResponse(res as Wire, "get-missing");
    assert.match(String(res?.error?.message), /job not found/);
  });
});

describe("MCP stdio round trip (in-process framing)", () => {
  it("initialize → tools/list → tools/call over NDJSON is spec compliant", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-rt-"));
    await ensureDataDirs(dataDir);
    const smoke = await smokeGitRepo();
    const e = new RunnerEngine(cfg(dataDir), { watchCi: false });
    await e.init();

    const input = new PassThrough();
    const frames: Buffer[] = [];
    const done = serveMcpStdio(
      input,
      (frame) => frames.push(frame),
      (msg) => handleMcpJsonRpc(e, msg),
    );
    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);
    send(INITIALIZE);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: "list-1", method: "tools/list" });
    send(startJobCall(3, smoke.repoPath, smoke.promptFile));
    send({ jsonrpc: "2.0", id: 4, method: "ping" });
    input.write("{not json}\n");
    input.end();
    await done;

    const raw = Buffer.concat(frames).toString("utf8");
    assert.ok(raw.endsWith("\n"));
    const lines = raw.trimEnd().split("\n");
    const msgs = lines.map((l) => JSON.parse(l) as Wire);
    assert.equal(msgs.length, 5, "one reply per request + parse error, none for notification");
    for (const m of msgs) assert.equal(m.jsonrpc, "2.0");
    const byId = (id: unknown) => msgs.find((m) => m.id === id);

    const init = byId(1);
    assertResponse(init, 1);
    assertInitializeResult(init);

    const list = byId("list-1");
    assertResponse(list, "list-1");
    assertToolsListResult(list);

    const call = byId(3);
    assertResponse(call, 3);
    assertToolCallResult(call);

    assertResponse(byId(4), 4);

    const parseErr = byId(null);
    assertResponse(parseErr, null);
    assert.equal((parseErr.error as { code: number }).code, -32700);
  });
});

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/runner.cjs");

/** Collect NDJSON replies from a child and resolve when `id` arrives. */
function rpcClient(child: ChildProcessWithoutNullStreams) {
  const seen: Wire[] = [];
  const waiters = new Map<unknown, (msg: Wire) => void>();
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Wire;
      seen.push(msg);
      waiters.get(msg.id)?.(msg);
    }
  });
  return {
    seen,
    request(msg: { id: string | number } & Wire, timeoutMs = 15_000): Promise<Wire> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for id ${msg.id}`)),
          timeoutMs,
        );
        waiters.set(msg.id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      });
    },
    notify(msg: Wire): void {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    },
  };
}

describe("MCP stdio round trip (built runner.cjs subprocess)", () => {
  it(
    "initialize → tools/list → tools/call dry-run is spec compliant",
    { skip: !existsSync(runner) && "run pnpm build first" },
    async () => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-proc-"));
      const smoke = await smokeGitRepo();
      const child = spawn(process.execPath, [runner, "mcp"], {
        env: {
          ...process.env,
          PRGENIE_RUNNER_DATA_DIR: dataDir,
          PRGENIE_RUNNER_DRY_RUN: "1",
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      try {
        const rpc = rpcClient(child);

        const init = await rpc.request(INITIALIZE);
        assertResponse(init, 1);
        assertInitializeResult(init);
        rpc.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

        const list = await rpc.request({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
        assertResponse(list, "tools");
        assertToolsListResult(list);

        const call = await rpc.request(
          startJobCall(42, smoke.repoPath, smoke.promptFile) as { id: string | number } & Wire,
        );
        assertResponse(call, 42);
        const jobId = assertToolCallResult(call);

        const get = await rpc.request({
          jsonrpc: "2.0",
          id: 43,
          method: "tools/call",
          params: { name: "get_job", arguments: { id: jobId } },
        });
        assertResponse(get, 43);
        assert.equal(
          (get.result as { structuredContent?: { id?: unknown } }).structuredContent?.id,
          jobId,
        );

        for (const msg of rpc.seen) assert.equal(msg.jsonrpc, "2.0");
        assert.equal(rpc.seen.length, 4, "no reply to the initialized notification");
        assert.ok(stderr.includes(MCP_STDIO_READY), stderr);

        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
        child.stdin.end();
        const code = await Promise.race([
          exited,
          new Promise<"hung">((r) => setTimeout(() => r("hung"), 15_000).unref()),
        ]);
        assert.equal(code, 0, "stdio server exits once the client closes stdin");
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    },
  );
});
