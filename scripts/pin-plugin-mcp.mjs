/**
 * Pin the copied plugin mcp.json so Cursor can spawn on Windows.
 * Keep mutations aligned with packages/core/src/plugin-mcp.ts pinPluginMcpJson.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: pin-plugin-mcp.mjs <plugin-dest-dir>");
  process.exit(1);
}

const mcpPath = path.join(dest, "mcp.json");
const serverPath = path.join(dest, "mcp", "server.cjs").split(path.sep).join("/");
if (!existsSync(path.join(dest, "mcp", "server.cjs"))) {
  console.error(
    `pin-plugin-mcp: missing ${serverPath}. Run pnpm build before link-plugin (link-plugin runs build first).`,
  );
  process.exit(1);
}
let raw = readFileSync(mcpPath, "utf8");
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

const cfg = JSON.parse(raw);
const servers = cfg.mcpServers ?? {};
const name = servers.prgenie ? "prgenie" : Object.keys(servers)[0];
if (!name || !servers[name]) {
  console.error(`pin-plugin-mcp: no mcpServers entry in ${mcpPath}`);
  process.exit(1);
}

const nodeCommand = process.execPath;
const useCmd = process.platform === "win32" && /\s/.test(nodeCommand);
servers[name] = {
  ...servers[name],
  type: "stdio",
  command: useCmd ? "cmd" : nodeCommand,
  args: useCmd ? ["/c", nodeCommand, serverPath] : [serverPath],
  cwd: dest.split(path.sep).join("/"),
};
cfg.mcpServers = servers;

writeFileSync(mcpPath, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: "utf8" });
console.log(`Pinned MCP ${name}:`);
console.log(`  ${servers[name].command} ${servers[name].args.join(" ")}`);
