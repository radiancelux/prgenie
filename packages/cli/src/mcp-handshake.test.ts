import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const serverJs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugin/mcp/server.cjs",
);

function takeNdjsonLine(buf: Buffer): { msg: unknown | null; rest: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return null;
  const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
  const rest = buf.subarray(nl + 1);
  if (!line) return { msg: null, rest };
  return { msg: JSON.parse(line), rest };
}

test("Cursor-style NDJSON initialize lists steward tools (RAD-82)", async () => {
  assert.ok(existsSync(serverJs), "packages/plugin/mcp/server.cjs missing — run pnpm build");

  const child = spawn(process.execPath, [serverJs], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout: Buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
  });

  const send = (msg: unknown) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const waitMsg = async (timeoutMs: number): Promise<Record<string, unknown>> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const taken = takeNdjsonLine(stdout);
      if (taken) {
        stdout = taken.rest;
        if (taken.msg && typeof taken.msg === "object") {
          return taken.msg as Record<string, unknown>;
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    const preview = stdout.toString("utf8").slice(0, 500);
    throw new Error(`timeout waiting for NDJSON MCP message. stdout=${JSON.stringify(preview)}`);
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "prgenie-test", version: "0" },
      },
    });
    const init = await waitMsg(4000);
    assert.equal(init.id, 1);
    const result = init.result as {
      serverInfo: { name: string };
      capabilities: { tools?: unknown };
    };
    assert.equal(result.serverInfo.name, "prgenie");
    assert.ok(result.capabilities.tools);

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    let toolsResult: Record<string, unknown> | undefined;
    for (let i = 0; i < 4; i++) {
      const msg = await waitMsg(4000);
      if (msg.id === 2) {
        toolsResult = msg;
        break;
      }
    }
    assert.ok(toolsResult, "tools/list response missing");
    const tools = (toolsResult.result as { tools: { name: string }[] }).tools;
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("steward_next"), "missing steward_next");
    assert.ok(names.has("bind_steward"), "missing bind_steward");
  } finally {
    child.kill("SIGTERM");
  }
});
