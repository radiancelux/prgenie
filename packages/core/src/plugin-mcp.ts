import { existsSync } from "node:fs";
import path from "node:path";

export const PRGENIE_MCP_NAME = "prgenie";

export type McpServerEntry = {
  type?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type McpFile = {
  mcpServers?: Record<string, McpServerEntry>;
};

export type McpJsonInspection = {
  names: string[];
  parseError?: string;
  hasBom: boolean;
  unresolvedPluginRoot: boolean;
  command?: string;
  args: string[];
  type?: string;
};

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function bufferHasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

export function parseMcpJson(raw: string): McpFile {
  return JSON.parse(stripBom(raw)) as McpFile;
}

function asEntry(value: unknown): McpServerEntry | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const args = Array.isArray(rec.args)
    ? rec.args.filter((a): a is string => typeof a === "string")
    : [];
  return {
    type: typeof rec.type === "string" ? rec.type : undefined,
    command: typeof rec.command === "string" ? rec.command : undefined,
    args,
    cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
  };
}

/** Cursor expands ${CURSOR_PLUGIN_ROOT}, not the Agent Plugins ${PLUGIN_ROOT}. */
export function argHasUnresolvedPluginRoot(arg: string): boolean {
  return /\$\{PLUGIN_ROOT\}/.test(arg) && !/\$\{CURSOR_PLUGIN_ROOT\}/.test(arg);
}

export function inspectMcpJson(raw: Buffer | string): McpJsonInspection {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  const hasBom = bufferHasUtf8Bom(buf);
  const text = stripBom(buf.toString("utf8"));
  try {
    const parsed = parseMcpJson(text);
    const servers = parsed.mcpServers ?? {};
    const names = Object.keys(servers);
    const entry = asEntry(servers[PRGENIE_MCP_NAME] ?? servers[names[0] ?? ""]) ?? {};
    const args = entry.args ?? [];
    return {
      names,
      hasBom,
      unresolvedPluginRoot: args.some(argHasUnresolvedPluginRoot),
      command: entry.command,
      args,
      type: entry.type,
    };
  } catch (err) {
    return {
      names: [],
      parseError: err instanceof Error ? err.message : String(err),
      hasBom,
      unresolvedPluginRoot: false,
      args: [],
    };
  }
}

export function pinPluginMcpJson(
  raw: string,
  opts: { pluginRoot: string; nodeCommand: string; serverName?: string },
): string {
  const cfg = parseMcpJson(raw);
  const servers = cfg.mcpServers ?? {};
  const name =
    opts.serverName ??
    (servers[PRGENIE_MCP_NAME] ? PRGENIE_MCP_NAME : Object.keys(servers)[0]);
  if (!name || !servers[name]) {
    throw new Error("pinPluginMcpJson: no mcpServers entry to pin");
  }
  const serverPath = path.join(opts.pluginRoot, "mcp", "server.cjs").split(path.sep).join("/");
  servers[name] = {
    ...servers[name],
    type: "stdio",
    command: opts.nodeCommand,
    args: [serverPath],
  };
  cfg.mcpServers = servers;
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export function sameNameCollision(a: string[], b: string[], name = PRGENIE_MCP_NAME): boolean {
  return a.includes(name) && b.includes(name);
}

export function commandLooksRunnable(command: string | undefined): boolean {
  if (!command) return false;
  if (path.isAbsolute(command)) return existsSync(command);
  return command === "node" || command === "node.exe";
}
