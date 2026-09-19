import { existsSync } from "node:fs";
import { git } from "./git.js";
import { getLocalPrNameStatus } from "./prs.js";

/** Default local CI suite (shepherd / implementor preflight). */
export const DEFAULT_CI_CHECKS = ["format:check", "lint", "typecheck", "test", "build"] as const;

export type CiPathKind = "docs" | "source" | "test" | "config" | "style" | "unknown";

export interface CiCheckMapping {
  check: string;
  reason: string;
}

export interface CiCheckSelection {
  checks: string[];
  reason: string;
  mapping: CiCheckMapping[];
  uncertain: boolean;
  changedPaths: string[];
}

const CONFIG_BASENAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.cjs",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierignore",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

export function normalizeCiPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(filePath: string): string {
  const parts = normalizeCiPath(filePath).split("/");
  return parts[parts.length - 1] ?? filePath;
}

/** Classify one changed path for smart CI. Unknown → full suite (never silent skip). */
export function classifyCiPath(filePath: string): CiPathKind {
  const p = normalizeCiPath(filePath);
  const base = basename(p);
  const lower = p.toLowerCase();

  if (
    CONFIG_BASENAMES.has(base) ||
    p.startsWith(".github/") ||
    p.startsWith("scripts/") ||
    /(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(p) ||
    /(^|\/)eslint\.config\./.test(p) ||
    /(^|\/)\.eslintrc/.test(p) ||
    p.endsWith("mcp.json") ||
    p.endsWith("hooks.json") ||
    p.endsWith("plugin.json") ||
    p.includes(".cursor/")
  ) {
    return "config";
  }

  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) ||
    /(^|\/)__tests__\//.test(p) ||
    /(^|\/)tests?\//.test(p)
  ) {
    return "test";
  }

  if (/\.([cm]?[jt]sx?)$/.test(lower)) return "source";

  if (
    /\.(md|txt)$/.test(lower) ||
    p.startsWith("docs/") ||
    /^(readme|license|changelog|authors|roadmap)(\.|$)/i.test(base)
  ) {
    return "docs";
  }

  if (/\.(css|scss|less|html|xml|json|ya?ml)$/.test(lower)) return "style";

  return "unknown";
}

function fullSuite(reason: string, paths: string[], uncertain: boolean): CiCheckSelection {
  const mapping: CiCheckMapping[] = DEFAULT_CI_CHECKS.map((check) => ({ check, reason }));
  return {
    checks: [...DEFAULT_CI_CHECKS],
    reason,
    mapping,
    uncertain,
    changedPaths: paths,
  };
}

/**
 * Path-aware check selection for implementor preflight and shepherd/export.
 * Uncertain mapping always returns the full configured suite.
 */
export function selectCiChecks(changedPaths: string[]): CiCheckSelection {
  const paths = [...new Set(changedPaths.map(normalizeCiPath).filter(Boolean))];
  if (paths.length === 0) {
    return fullSuite("no changed paths; running full suite", paths, true);
  }

  const kinds = paths.map(classifyCiPath);
  if (kinds.some((kind) => kind === "unknown")) {
    return fullSuite("uncertain path mapping; running full suite", paths, true);
  }
  if (kinds.some((kind) => kind === "config")) {
    return fullSuite("config/CI scripts changed; running full suite", paths, false);
  }

  const onlyDocsOrStyle = kinds.every((kind) => kind === "docs" || kind === "style");
  if (onlyDocsOrStyle) {
    const reason = kinds.every((kind) => kind === "docs")
      ? "docs/markdown-only — format only, skip lint/test/build"
      : "docs/style-only — format only, skip lint/test/build";
    return {
      checks: ["format:check"],
      reason,
      mapping: [{ check: "format:check", reason }],
      uncertain: false,
      changedPaths: paths,
    };
  }

  const hasCli = paths.some((p) => p.startsWith("packages/cli/"));
  const hasCore = paths.some((p) => p.startsWith("packages/core/"));
  const hasExtension = paths.some((p) => p.startsWith("packages/extension/"));
  const scope =
    [hasCli && "cli", hasCore && "core", hasExtension && "extension"].filter(Boolean).join("+") ||
    "source";
  const reason = `${scope} source/test changed — format, lint, typecheck, test, build`;
  return {
    checks: [...DEFAULT_CI_CHECKS],
    reason,
    mapping: DEFAULT_CI_CHECKS.map((check) => ({ check, reason })),
    uncertain: false,
    changedPaths: paths,
  };
}

export function resolveCiCwd(cwd: string, worktreePath: string | null | undefined): string {
  if (worktreePath && existsSync(worktreePath)) return worktreePath;
  return cwd;
}

function addSplitPaths(set: Set<string>, raw: string): void {
  const parts = raw.split("\t").filter(Boolean);
  const file = parts[parts.length - 1];
  if (file) set.add(normalizeCiPath(file));
}

/** Committed loop diff plus dirty/untracked files in cwd (implementor worktree). */
export async function changedPathsForCi(cwd: string, id?: string): Promise<string[]> {
  const paths = new Set<string>();
  if (id) {
    try {
      for (const file of await getLocalPrNameStatus(cwd, id)) {
        addSplitPaths(paths, file.path);
      }
    } catch {
      // Packet missing or no git — fall through to dirty tree.
    }
  }
  try {
    for (const args of [
      ["diff", "--name-only", "HEAD"],
      ["diff", "--name-only", "--cached"],
      ["ls-files", "-o", "--exclude-standard"],
    ] as string[][]) {
      const result = await git(cwd, args, { allowFail: true });
      if (result.code !== 0) continue;
      for (const line of result.stdout.split("\n")) {
        if (line.trim()) addSplitPaths(paths, line.trim());
      }
    }
  } catch {
    // ignore
  }
  return [...paths];
}

export function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  return fallback;
}
