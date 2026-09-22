import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Generated MCP/hook bundles from `scripts/build.mjs` (esbuild).
 * These are gitignored — build on link / pack / CI; do not commit them.
 */
export const PLUGIN_BUNDLE_OUTFILES = [
  "packages/plugin/mcp/server.cjs",
  "packages/plugin/hooks/capture-subagent.cjs",
  "packages/plugin/hooks/github-gate.cjs",
  "packages/plugin/hooks/review-inbox.cjs",
] as const;

/** Source trees/files whose mtime must not be newer than any bundle outfile. */
export const PLUGIN_BUNDLE_SOURCE_PATHS = [
  "packages/cli/src",
  "packages/core/src",
  "scripts/build.mjs",
] as const;

export type PluginBundleStatus = {
  ok: boolean;
  missing: string[];
  stale: string[];
  summary: string;
  fix: string;
};

const BUILD_FIX = "From the monorepo root: pnpm build (link-plugin runs build first).";

async function newestMtimeMs(absPath: string): Promise<number> {
  const info = await stat(absPath);
  if (info.isFile()) return info.mtimeMs;
  if (!info.isDirectory()) return 0;

  let newest = info.mtimeMs;
  const entries = await readdir(absPath, { withFileTypes: true });
  for (const entry of entries) {
    // Skip heavy / irrelevant trees under src.
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const child = path.join(absPath, entry.name);
    const childNewest = await newestMtimeMs(child);
    if (childNewest > newest) newest = childNewest;
  }
  return newest;
}

async function newestSourceMtimeMs(packageRoot: string): Promise<number> {
  let newest = 0;
  for (const rel of PLUGIN_BUNDLE_SOURCE_PATHS) {
    const abs = path.join(packageRoot, rel);
    if (!existsSync(abs)) continue;
    const t = await newestMtimeMs(abs);
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * Whether generated plugin MCP/hook bundles exist and are not older than sources.
 */
export async function inspectPluginBundles(packageRoot: string): Promise<PluginBundleStatus> {
  const missing: string[] = [];
  const stale: string[] = [];
  const sourceNewest = await newestSourceMtimeMs(packageRoot);

  for (const rel of PLUGIN_BUNDLE_OUTFILES) {
    const abs = path.join(packageRoot, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    if (sourceNewest <= 0) continue;
    const outMtime = (await stat(abs)).mtimeMs;
    // Small skew tolerance for FS timestamp granularity / copy races.
    if (outMtime + 1000 < sourceNewest) {
      stale.push(rel);
    }
  }

  if (missing.length === 0 && stale.length === 0) {
    return {
      ok: true,
      missing,
      stale,
      summary: "Plugin MCP/hook bundles are present and not older than sources.",
      fix: BUILD_FIX,
    };
  }

  const parts: string[] = [];
  if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
  if (stale.length) parts.push(`stale vs sources: ${stale.join(", ")}`);
  return {
    ok: false,
    missing,
    stale,
    summary: `Generated plugin bundles need a rebuild (${parts.join("; ")}).`,
    fix: BUILD_FIX,
  };
}

export function formatPluginBundlesError(status: PluginBundleStatus): string {
  return `${status.summary}\n  fix: ${status.fix}`;
}

/** Throw when packages/plugin MCP/hook bundles are missing or older than sources. */
export async function assertPluginBundlesReady(packageRoot: string): Promise<void> {
  const status = await inspectPluginBundles(packageRoot);
  if (status.ok) return;
  throw new Error(formatPluginBundlesError(status));
}
