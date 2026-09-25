import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Parse `model:` from a Cursor agent markdown frontmatter (no ids hardcoded in core). */
export function parseAgentModelFrontmatter(raw: string): string | null {
  const match = raw.match(FRONTMATTER);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("model:")) continue;
    const value = trimmed.slice("model:".length).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function agentHome(): string {
  const override = process.env.PRGENIE_AGENT_HOME?.trim();
  return override && override.length > 0 ? override : os.homedir();
}

/** Candidate agent definition paths (installed plugin/user agents, not the repo under review). */
export function pluginAgentDefinitionPaths(agentName: string, home = agentHome()): string[] {
  return [
    path.join(home, ".cursor", "agents", `${agentName}.md`),
    path.join(home, ".cursor", "plugins", "local", "prgenie", "agents", `${agentName}.md`),
  ];
}

/** Read model slug from the installed PR Genie agent definition file. */
export async function readPluginAgentModel(
  _cwd: string,
  agentName: string,
): Promise<string | null> {
  for (const file of pluginAgentDefinitionPaths(agentName)) {
    try {
      const raw = await readFile(file, "utf8");
      const model = parseAgentModelFrontmatter(raw);
      if (model) return model;
    } catch {
      // try next candidate
    }
  }
  return null;
}
