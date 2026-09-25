import { readFile } from "node:fs/promises";
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

/** Read model slug from `packages/plugin/agents/<agentName>.md` under the repo root. */
export async function readPluginAgentModel(cwd: string, agentName: string): Promise<string | null> {
  const file = path.join(cwd, "packages", "plugin", "agents", `${agentName}.md`);
  try {
    const raw = await readFile(file, "utf8");
    return parseAgentModelFrontmatter(raw);
  } catch {
    return null;
  }
}
