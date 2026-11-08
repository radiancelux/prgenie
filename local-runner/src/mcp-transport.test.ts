import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { handleMcpJsonRpc, RUNNER_MCP_TOOL_NAMES, handleRunnerTool } from "./mcp-handlers.js";
import { MCP_STDIO_READY } from "./mcp-stdio.js";
import { ensureDataDirs } from "./store.js";

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

const execFileAsync = promisify(execFile);

describe("runner MCP JSON-RPC (in-process)", () => {
  let dataDir = "";
  let smokeRepo = "";
  let smokePrompt = "";

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-"));
    await ensureDataDirs(dataDir);
    smokeRepo = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-repo-"));
    await execFileAsync("git", ["-C", smokeRepo, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", smokeRepo, "commit", "--allow-empty", "-m", "init"]);
    smokePrompt = path.join(smokeRepo, "README.md");
    await writeFile(smokePrompt, "# smoke\n", "utf8");
  });

  function engine(): RunnerEngine {
    return new RunnerEngine(cfg(dataDir), { watchCi: false });
  }

  it("initialize → tools/list includes job tools", async () => {
    const e = engine();
    await e.init();
    const init = await handleMcpJsonRpc(e, {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    assert.ok(init?.result);
    const tools = await handleMcpJsonRpc(e, { id: 2, method: "tools/list" });
    const names = ((tools?.result as { tools?: { name: string }[] })?.tools ?? []).map(
      (t) => t.name,
    );
    assert.deepEqual(names, RUNNER_MCP_TOOL_NAMES);
    assert.ok(names.includes("settings"));
  });

  it("tools/call start_job dry-run end to end", async () => {
    const e = engine();
    await e.init();
    const call = await handleMcpJsonRpc(e, {
      id: 3,
      method: "tools/call",
      params: {
        name: "start_job",
        arguments: {
          branch: "chore/mcp-dry-run",
          promptFile: smokePrompt,
          repoPath: smokeRepo,
          dryRun: true,
          maxRounds: 1,
        },
      },
    });
    assert.ok(call?.result);
    assert.ok(!(call as { error?: unknown }).error);
    const structured = (call?.result as { structuredContent?: { id?: string } })?.structuredContent;
    assert.ok(structured?.id);
    const job = await handleRunnerTool(e, "get_job", { id: structured!.id! });
    assert.ok(job);
  });

  it("unknown method returns JSON-RPC error", async () => {
    const e = engine();
    const bad = await handleMcpJsonRpc(e, { id: 9, method: "nope/method" });
    assert.equal(bad?.error?.code, -32601);
  });
});

describe("runner MCP stdio subprocess", () => {
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/runner.cjs");

  it("handshake lists tools when dist exists", { skip: !existsSync(runner) }, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-mcp-spawn-"));
    await mkdir(dataDir, { recursive: true });
    const child = spawn(process.execPath, [runner, "mcp"], {
      env: {
        ...process.env,
        PRGENIE_RUNNER_DATA_DIR: dataDir,
        PRGENIE_RUNNER_DRY_RUN: "1",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    const send = (msg: unknown) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 800));
    child.kill("SIGTERM");
    assert.match(stderr, new RegExp(MCP_STDIO_READY.replace(/[[\]]/g, "\\$&")));
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[] } });
    const tools = lines.find((l) => l.id === 2);
    assert.ok(tools?.result?.tools?.length);
    assert.ok(tools!.result!.tools!.some((t) => t.name === "start_job"));
  });
});
