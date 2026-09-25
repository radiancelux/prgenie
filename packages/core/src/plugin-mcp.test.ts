import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  argHasUnresolvedPluginRoot,
  bufferHasUtf8Bom,
  inspectMcpJson,
  pinPluginMcpJson,
  sameNameCollision,
  stripBom,
  windowsStdioSpawn,
} from "./plugin-mcp.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-plugin-mcp-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("Cursor does not expand ${PLUGIN_ROOT} but does expand ${CURSOR_PLUGIN_ROOT}", () => {
  assert.equal(argHasUnresolvedPluginRoot("${PLUGIN_ROOT}/mcp/server.cjs"), true);
  assert.equal(argHasUnresolvedPluginRoot("${CURSOR_PLUGIN_ROOT}/mcp/server.cjs"), false);
  assert.equal(argHasUnresolvedPluginRoot("C:/plugins/prgenie/mcp/server.cjs"), false);
});

test("inspectMcpJson flags UTF-8 BOM and parse errors", () => {
  const ok = inspectMcpJson(
    Buffer.from('{"mcpServers":{"prgenie":{"command":"node","args":["./s.cjs"]}}}\n'),
  );
  assert.equal(ok.hasBom, false);
  assert.deepEqual(ok.names, ["prgenie"]);
  assert.equal(ok.unresolvedPluginRoot, false);

  const bom = inspectMcpJson(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"mcpServers":{"prgenie":{"command":"node"}}}'),
    ]),
  );
  assert.equal(bom.hasBom, true);
  assert.deepEqual(bom.names, ["prgenie"]);
  assert.equal(bufferHasUtf8Bom(Buffer.from([0xef, 0xbb, 0xbf, 0x7b])), true);
  assert.equal(stripBom("\uFEFF{"), "{");

  const bad = inspectMcpJson("{not-json");
  assert.ok(bad.parseError);
});

test("inspectMcpJson flags unresolved PLUGIN_ROOT (RAD-82)", () => {
  const stuck = inspectMcpJson(
    '{"mcpServers":{"prgenie":{"command":"node","args":["${PLUGIN_ROOT}/mcp/server.cjs"]}}}',
  );
  assert.equal(stuck.unresolvedPluginRoot, true);

  const cursorVar = inspectMcpJson(
    '{"mcpServers":{"prgenie":{"command":"node","args":["${CURSOR_PLUGIN_ROOT}/mcp/server.cjs"]}}}',
  );
  assert.equal(cursorVar.unresolvedPluginRoot, false);
});

test("sameNameCollision is only plugin + workspace both named prgenie", () => {
  assert.equal(sameNameCollision(["prgenie"], ["prgenie"]), true);
  assert.equal(sameNameCollision(["prgenie-dev"], ["prgenie"]), false);
  assert.equal(sameNameCollision(["prgenie"], []), false);
});

test("windowsStdioSpawn wraps Program Files node.exe in cmd /c", () => {
  const spaced = "C:/Program Files/nodejs/node.exe";
  const wrapped = windowsStdioSpawn(spaced, "C:/plugin/mcp/server.cjs", "win32");
  assert.equal(wrapped.command, "cmd");
  assert.deepEqual(wrapped.args, ["/c", spaced, "C:/plugin/mcp/server.cjs"]);
  const unix = windowsStdioSpawn("/usr/bin/node", "/plugin/mcp/server.cjs", "linux");
  assert.equal(unix.command, "/usr/bin/node");
  assert.deepEqual(unix.args, ["/plugin/mcp/server.cjs"]);
});

test("pinPluginMcpJson writes stdio + absolute node + absolute server (no BOM)", async () => {
  const pluginRoot = path.join(dir, "prgenie");
  await mkdir(path.join(pluginRoot, "mcp"), { recursive: true });
  await writeFile(path.join(pluginRoot, "mcp", "server.cjs"), "/* mcp */\n");
  const pinned = pinPluginMcpJson(
    JSON.stringify({
      mcpServers: {
        prgenie: {
          command: "node",
          args: ["${PLUGIN_ROOT}/mcp/server.cjs"],
        },
      },
    }),
    { pluginRoot, nodeCommand: process.execPath },
  );
  assert.equal(pinned.charCodeAt(0) === 0xfeff, false);
  const parsed = JSON.parse(pinned) as {
    mcpServers: { prgenie: { type: string; command: string; args: string[] } };
  };
  assert.equal(parsed.mcpServers.prgenie.type, "stdio");
  assert.equal(
    (parsed.mcpServers.prgenie as { timeout?: number }).timeout,
    2400,
    "RAD-100/RAD-133: pin 40m tools/call timeout (seconds)",
  );
  const expectCmd = process.platform === "win32" && /\s/.test(process.execPath);
  if (expectCmd) {
    assert.equal(parsed.mcpServers.prgenie.command, "cmd");
    assert.equal(parsed.mcpServers.prgenie.args[0], "/c");
    assert.equal(parsed.mcpServers.prgenie.args[1], process.execPath);
  } else {
    assert.equal(parsed.mcpServers.prgenie.command, process.execPath);
  }
  assert.ok(
    parsed.mcpServers.prgenie.args.some((a) =>
      a.split(path.sep).join("/").endsWith("mcp/server.cjs"),
    ),
  );
  const inspect = inspectMcpJson(Buffer.from(pinned, "utf8"));
  assert.equal(inspect.hasBom, false);
  assert.equal(inspect.unresolvedPluginRoot, false);

  const winPinned = pinPluginMcpJson(
    JSON.stringify({
      mcpServers: { prgenie: { command: "node", args: ["${PLUGIN_ROOT}/mcp/server.cjs"] } },
    }),
    {
      pluginRoot,
      nodeCommand: "C:/Program Files/nodejs/node.exe",
      platform: "win32",
    },
  );
  const win = JSON.parse(winPinned) as {
    mcpServers: { prgenie: { command: string; args: string[] } };
  };
  assert.equal(win.mcpServers.prgenie.command, "cmd");
  assert.equal(win.mcpServers.prgenie.args[0], "/c");

  const raised = pinPluginMcpJson(
    JSON.stringify({
      mcpServers: {
        prgenie: {
          command: "node",
          args: ["${CURSOR_PLUGIN_ROOT}/mcp/server.cjs"],
          timeout: 60,
        },
      },
    }),
    { pluginRoot, nodeCommand: process.execPath },
  );
  const raisedParsed = JSON.parse(raised) as {
    mcpServers: { prgenie: { timeout?: number } };
  };
  assert.equal(
    raisedParsed.mcpServers.prgenie.timeout,
    2400,
    "RAD-100: pin raises sub-2400 timeouts to the floor",
  );

  const keptHigh = pinPluginMcpJson(
    JSON.stringify({
      mcpServers: {
        prgenie: {
          command: "node",
          args: ["${CURSOR_PLUGIN_ROOT}/mcp/server.cjs"],
          timeout: 3600,
        },
      },
    }),
    { pluginRoot, nodeCommand: process.execPath },
  );
  assert.equal(
    (JSON.parse(keptHigh) as { mcpServers: { prgenie: { timeout?: number } } }).mcpServers.prgenie
      .timeout,
    3600,
    "RAD-100: explicit higher timeout still wins",
  );
});

test("pin-plugin-mcp.mjs writes UTF-8 without BOM and pins execPath", async () => {
  const pluginRoot = path.join(dir, "copied-plugin");
  await mkdir(path.join(pluginRoot, "mcp"), { recursive: true });
  await writeFile(path.join(pluginRoot, "mcp", "server.cjs"), "/* mcp */\n");
  await writeFile(
    path.join(pluginRoot, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        prgenie: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/mcp/server.cjs"] },
      },
    }),
  );
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../scripts/pin-plugin-mcp.mjs",
  );
  execFileSync(process.execPath, [script, pluginRoot], { encoding: "utf8" });
  const bytes = await readFile(path.join(pluginRoot, "mcp.json"));
  assert.equal(bufferHasUtf8Bom(bytes), false);
  const pinned = JSON.parse(bytes.toString("utf8")) as {
    mcpServers: { prgenie: { command: string; type: string; args: string[] } };
  };
  assert.equal(pinned.mcpServers.prgenie.type, "stdio");
  assert.equal(
    (pinned.mcpServers.prgenie as { timeout?: number }).timeout,
    2400,
    "pin-plugin-mcp.mjs preserves/raises timeout (RAD-100/RAD-133)",
  );
  const expectCmd = process.platform === "win32" && /\s/.test(process.execPath);
  if (expectCmd) {
    assert.equal(pinned.mcpServers.prgenie.command, "cmd");
    assert.equal(pinned.mcpServers.prgenie.args[0], "/c");
    assert.equal(pinned.mcpServers.prgenie.args[1], process.execPath);
  } else {
    assert.equal(pinned.mcpServers.prgenie.command, process.execPath);
  }
  assert.ok(pinned.mcpServers.prgenie.args.some((a) => a.endsWith("mcp/server.cjs")));
});
