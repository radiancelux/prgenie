import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { hashGuidanceContent, normalizeGuidanceText } from "./repo-guidance.js";
import type { RepoContextSnapshot } from "./types.js";

export const REPO_CONTEXT_CANONICAL = ".prgenie/context.md";

export type { RepoContextSnapshot };

function posixRel(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function parseFrontmatterRequired(raw: string): boolean {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return false;
  return /^required:\s*true\s*$/im.test(match[1] ?? "");
}

/** Extract path-like list items — paths only, no inline bodies. */
export function parseContextPaths(content: string): string[] {
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const paths: string[] = [];
  for (const line of normalizeGuidanceText(body).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const bullet = trimmed.match(/^[-*]\s+(.+)$/) ?? trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (!bullet) continue;
    let value = bullet[1].trim();
    if (value.startsWith("`") && value.endsWith("`")) value = value.slice(1, -1);
    if (!value || value.includes("\n")) continue;
    paths.push(value.replace(/\\/g, "/"));
  }
  return [...new Set(paths)];
}

export async function discoverRepoContextSource(
  repoRoot: string,
): Promise<{ path: string; content: string } | null> {
  const canonical = path.join(repoRoot, ...REPO_CONTEXT_CANONICAL.split("/"));
  if (!(await fileExists(canonical))) return null;
  try {
    const content = await readFile(canonical, "utf8");
    if (!content.trim()) return null;
    return { path: REPO_CONTEXT_CANONICAL, content };
  } catch {
    return null;
  }
}

export async function loadRepoContextSnapshot(
  repoRoot: string,
  now = new Date().toISOString(),
): Promise<RepoContextSnapshot> {
  const source = await discoverRepoContextSource(repoRoot);
  if (!source) {
    return {
      sourcePath: null,
      contentHash: null,
      recordedAt: now,
      paths: [],
      required: false,
      missing: false,
    };
  }
  const required = parseFrontmatterRequired(source.content);
  const paths = parseContextPaths(source.content);
  const missing = required && paths.length === 0;
  return {
    sourcePath: source.path,
    contentHash: hashGuidanceContent(source.content),
    recordedAt: now,
    paths,
    required,
    missing,
  };
}

/** Implementor Task brief — point at paths; agent must Read before coding. */
export function formatImplementorContextBrief(snapshot: RepoContextSnapshot): string | null {
  if (snapshot.missing) {
    return [
      "## Repo context (required)",
      "",
      `\`.prgenie/context.md\` is marked \`required: true\` but lists no paths. Add CONTRIBUTING / standards / skill paths before implementing.`,
    ].join("\n");
  }
  if (snapshot.paths.length === 0) {
    return null;
  }
  const lines = [
    "## Repo context (read before implementing)",
    "",
    `Source: \`${snapshot.sourcePath}\`${snapshot.contentHash ? `  Hash: \`${snapshot.contentHash}\`` : ""}`,
    "",
    "Read these paths in the worktree **before** writing product code (paths only — do not expect inline bodies here):",
    ...snapshot.paths.map((p) => `- \`${p}\``),
  ];
  return lines.join("\n");
}
