import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_STDIO_READY } from "./mcp-stdio.js";
export { MCP_STDIO_READY };

function moduleDir(): string {
  try {
    const url = import.meta.url;
    if (url) return path.dirname(fileURLToPath(url));
  } catch {
    // esbuild CJS bundle has an empty import.meta
  }
  const argv1 = process.argv[1];
  return argv1 ? path.dirname(path.resolve(argv1)) : process.cwd();
}

export function bundledMcpServerPath(): string {
  const here = moduleDir();
  const candidates = [
    path.resolve(here, "../../plugin/mcp/server.cjs"),
    path.resolve(here, "../plugin/mcp/server.cjs"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `packages/plugin/mcp/server.cjs missing (looked in ${candidates.join(", ")}). Run pnpm build.`,
    );
  }
  return found;
}

function takeNdjsonLine(buf: Buffer): { msg: unknown | null; rest: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return null;
  const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
  const rest = buf.subarray(nl + 1);
  if (!line) return { msg: null, rest };
  return { msg: JSON.parse(line), rest };
}

export async function smokeMcpHandshake(
  serverJs = bundledMcpServerPath(),
  timeoutMs = 2000,
): Promise<{ elapsedMs: number; tools: string[]; stderr: string; ready: boolean }> {
  if (!existsSync(serverJs)) {
    throw new Error(`MCP server missing: ${serverJs} — run pnpm build`);
  }
  const started = Date.now();
  const child = spawn(process.execPath, [serverJs], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const send = (msg: unknown) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const waitMsg = async (): Promise<Record<string, unknown>> => {
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const taken = takeNdjsonLine(stdout);
      if (taken) {
        stdout = taken.rest;
        if (taken.msg && typeof taken.msg === "object") {
          return taken.msg as Record<string, unknown>;
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `MCP handshake timed out after ${timeoutMs}ms. stderr=${JSON.stringify(stderr)} stdout=${JSON.stringify(stdout.toString("utf8").slice(0, 400))}`,
    );
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "prgenie-smoke", version: "0" },
      },
    });
    const init = await waitMsg();
    if (init.id !== 1) throw new Error(`initialize id mismatch: ${JSON.stringify(init)}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    let toolsResult: Record<string, unknown> | undefined;
    for (let i = 0; i < 4; i++) {
      const msg = await waitMsg();
      if (msg.id === 2) {
        toolsResult = msg;
        break;
      }
    }
    if (!toolsResult) throw new Error("tools/list response missing");
    const tools = ((toolsResult.result as { tools?: { name: string }[] })?.tools ?? []).map(
      (t) => t.name,
    );
    return {
      elapsedMs: Date.now() - started,
      tools,
      stderr,
      ready: stderr.includes(MCP_STDIO_READY),
    };
  } finally {
    child.kill("SIGTERM");
  }
}

export function formatMcpSmoke(result: Awaited<ReturnType<typeof smokeMcpHandshake>>): string {
  const need = ["steward_next", "bind_steward"];
  const missing = need.filter((n) => !result.tools.includes(n));
  const lines = [
    `prgenie mcp --smoke ${missing.length ? "failed" : "ok"} in ${result.elapsedMs}ms`,
    `  ready-on-stderr: ${result.ready}`,
    `  tools: ${result.tools.length}`,
    `  steward_next: ${result.tools.includes("steward_next")}`,
    `  bind_steward: ${result.tools.includes("bind_steward")}`,
  ];
  if (missing.length) lines.push(`  missing: ${missing.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
