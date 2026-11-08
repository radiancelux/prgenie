import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runnerTokenFile } from "./config.js";
import {
  claudeCodeMcpAddCommand,
  cursorMcpJsonSnippet,
  formatInitReport,
  RUNNER_MCP_SERVER_ID,
  runInit,
  vscodeMcpJsonSnippet,
} from "./init.js";

describe("prgenie init", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "prgenie-init-"));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("win32 init output omits bash export as the primary token line", () => {
    const result = {
      dataDir: "C:\\Users\\u\\.prgenie\\local-runner",
      tokenFile: "C:\\Users\\u\\.prgenie\\local-runner\\runner.token",
      createdToken: true,
    };
    const report = formatInitReport(result, {});
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const win = formatInitReport(result, {});
      assert.doesNotMatch(win, /^  export PRGENIE_RUNNER_TOKEN=/m);
      assert.match(win, /\$env:PRGENIE_RUNNER_TOKEN = Get-Content/);
      assert.match(win, /Git Bash/);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
    assert.match(report, /Next:.*doctor/);
  });

  it("creates data dir and token file", async () => {
    const dataDir = path.join(dir, "data");
    const result = await runInit({ dataDir });
    assert.equal(result.createdToken, true);
    const token = (await readFile(runnerTokenFile(dataDir), "utf8")).trim();
    assert.ok(token.length >= 16);
    assert.match(formatInitReport(result), /prgenie doctor/);
    assert.match(formatInitReport(result), /reads the token file automatically/);
    assert.doesNotMatch(formatInitReport(result), /export PRGENIE_RUNNER_DATA_DIR/);
  });

  it("does not rotate token without --force-token", async () => {
    const dataDir = path.join(dir, "keep");
    const first = await runInit({ dataDir });
    const token = await readFile(first.tokenFile, "utf8");
    const second = await runInit({ dataDir });
    assert.equal(second.createdToken, false);
    assert.equal(await readFile(first.tokenFile, "utf8"), token);
  });
});

describe("prgenie config snippets", () => {
  it("uses a server id distinct from the plugin's prgenie MCP", () => {
    assert.equal(RUNNER_MCP_SERVER_ID, "prgenie-runner");
    const cursor = JSON.parse(cursorMcpJsonSnippet()) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(cursor.mcpServers, {
      "prgenie-runner": { type: "stdio", command: "npx", args: ["-y", "prgenie", "mcp"] },
    });
    const vscode = JSON.parse(vscodeMcpJsonSnippet()) as { servers: Record<string, unknown> };
    assert.deepEqual(Object.keys(vscode.servers), ["prgenie-runner"]);
  });

  it("prints the Claude Code stdio registration command", () => {
    assert.equal(
      claudeCodeMcpAddCommand(),
      "claude mcp add --scope user prgenie-runner -- npx -y prgenie mcp\n",
    );
    assert.equal(
      claudeCodeMcpAddCommand(true),
      "claude mcp add --scope user prgenie-runner -- prgenie mcp\n",
    );
  });

  it("global mode uses prgenie binary in MCP snippets", () => {
    const cursor = JSON.parse(cursorMcpJsonSnippet(true)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(cursor.mcpServers["prgenie-runner"].args, ["mcp"]);
    assert.equal(cursor.mcpServers["prgenie-runner"].command, "prgenie");
  });
});
