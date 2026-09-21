import path from "node:path";
import { findGitRoot } from "./git.js";

/** Candidate workspace paths for MCP when tool args omit `cwd`. */
export function mcpCwdCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const normalized = path.normalize(trimmed);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  add(process.env.CURSOR_PROJECT_DIR);
  const workspacePaths = process.env.WORKSPACE_FOLDER_PATHS;
  if (workspacePaths) {
    for (const part of workspacePaths.split(path.delimiter)) {
      add(part);
    }
  }
  add(process.cwd());
  return out;
}

function expectedWorkspaceRoot(candidates: string[]): string {
  return (
    process.env.CURSOR_PROJECT_DIR?.trim() ||
    process.env.WORKSPACE_FOLDER_PATHS?.split(path.delimiter).find((p) => p.trim())?.trim() ||
    candidates[0] ||
    "workspace git root"
  );
}

function formatNotGitRepoError(candidates: string[]): string {
  const expected = expectedWorkspaceRoot(candidates);
  const pluginRoot = process.env.CURSOR_PLUGIN_ROOT?.trim();
  const serverCwd = path.normalize(process.cwd());
  const pluginNote =
    pluginRoot && path.normalize(pluginRoot) === serverCwd
      ? ` MCP server cwd is the plugin install (${pluginRoot}), not the workspace.`
      : "";
  const tried = candidates.length ? candidates.join(", ") : serverCwd;
  return `Not inside a git repository. Expected workspace git root at ${expected}.${pluginNote} Tried: ${tried}`;
}

/**
 * Resolve the git root for MCP/steward tools when callers omit `cwd`.
 * Prefers explicit cwd, then Cursor workspace env vars, then process.cwd().
 */
export async function resolveMcpGitRoot(explicitCwd?: string): Promise<string> {
  if (explicitCwd?.trim()) {
    const root = await findGitRoot(explicitCwd.trim());
    if (!root) {
      throw new Error(formatNotGitRepoError([path.normalize(explicitCwd.trim())]));
    }
    return root;
  }

  const candidates = mcpCwdCandidates();
  for (const candidate of candidates) {
    const root = await findGitRoot(candidate);
    if (root) return root;
  }

  throw new Error(formatNotGitRepoError(candidates));
}
