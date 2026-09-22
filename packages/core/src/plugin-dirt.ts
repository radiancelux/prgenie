import { git, requireGitRoot } from "./git.js";
import { listWorktrees, primaryWorktreePath } from "./worktrees.js";

/**
 * Bundled MCP/hooks outputs under packages/plugin that `pnpm build` / link-plugin rewrite.
 * Dirty tracked copies on primary are not loop work — peel would carry them into `.loops/<id>`.
 */
export function isPluginBuildArtifact(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return /^packages\/plugin\/(hooks|mcp)\/.+\.cjs$/i.test(norm);
}

/**
 * Dirty **tracked** plugin build artifacts on the primary checkout (not untracked-only).
 * Inspects primary even when `cwd` is already a `.loops/<id>` worktree.
 */
export async function listDirtyPluginBuildArtifacts(cwd: string): Promise<string[]> {
  const root = await requireGitRoot(cwd);
  const trees = await listWorktrees(root);
  const primary = primaryWorktreePath(trees) ?? root;
  // Status of primary working tree — peel/create operates from there.
  const result = await git(primary, ["status", "--porcelain", "--", "packages/plugin"], {
    allowFail: true,
  });
  if (result.code !== 0 || !result.stdout.trim()) return [];

  const dirty: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const text = line.replace(/\r$/, "");
    if (!text || text.length < 4) continue;
    const xy = text.slice(0, 2);
    // Untracked-only (??) is not "tracked dirt".
    if (xy === "??") continue;
    const body = text.slice(3);
    const arrow = body.indexOf(" -> ");
    const file = (arrow >= 0 ? body.slice(arrow + 4) : body).replace(/\\/g, "/");
    if (isPluginBuildArtifact(file)) dirty.push(file);
  }
  return [...new Set(dirty)].sort();
}

export function formatDirtyPluginBuildArtifactsError(paths: string[]): string {
  const listed = paths.map((p) => `  ${p}`).join("\n");
  return (
    `Refusing to create a local PR while the primary checkout has dirty tracked plugin build artifacts:\n` +
    `${listed}\n` +
    `These are usually leftover from pnpm build / link-plugin and are not part of this loop. ` +
    `Stash or restore them on primary, then retry:\n` +
    `  git stash push -m "plugin build dirt" -- packages/plugin/hooks packages/plugin/mcp\n` +
    `  # or: git restore -- packages/plugin/hooks packages/plugin/mcp\n` +
    `After create, Switch / open the exclusive ../<repo>.loops/<id> worktree before implementing — never commit on primary when that worktree exists.`
  );
}

/** Throw when primary has dirty tracked plugin `.cjs` bundles that would pollute a new loop peel. */
export async function assertNoDirtyPluginBuildArtifacts(cwd: string): Promise<void> {
  const dirty = await listDirtyPluginBuildArtifacts(cwd);
  if (dirty.length === 0) return;
  throw new Error(formatDirtyPluginBuildArtifactsError(dirty));
}

export function dirtyPluginDoctorFix(paths: string[]): string {
  return (
    `On the primary checkout: git stash push -m "plugin build dirt" -- ${paths.join(" ")} ` +
    `(or git restore -- those paths). Then create the loop and Switch into ../<repo>.loops/<id>.`
  );
}
