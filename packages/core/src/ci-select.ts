import { existsSync } from "node:fs";
import { git } from "./git.js";
import { getLocalPrNameStatus } from "./prs.js";

/** Default local CI suite (shepherd / implementor preflight) when mapping is uncertain or config-wide. */
export const DEFAULT_CI_CHECKS = ["format:check", "lint", "typecheck", "test", "build"] as const;

/** Packages that support path-scoped lint / typecheck / unit tests (not full-monorepo `pnpm test`). */
export const SCOPABLE_PACKAGES = ["core", "cli", "extension"] as const;
export type ScopablePackage = (typeof SCOPABLE_PACKAGES)[number];

export type CiPathKind = "docs" | "source" | "test" | "config" | "style" | "unknown";

export interface CiCheckMapping {
  check: string;
  reason: string;
}

export interface CiCheckSelection {
  /** Check names to run (`format:check`, `lint:core`, `test`, …). */
  checks: string[];
  /** Why this plan was chosen (print these; RAD-105). */
  reason: string[];
  mapping: CiCheckMapping[];
  uncertain: boolean;
  changedPaths: string[];
  /** True when checks are per-package scoped (not root `pnpm test` / full suite). */
  packageScoped?: boolean;
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

const SCOPABLE_SET = new Set<string>(SCOPABLE_PACKAGES);

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
    /\.(md|mdc|txt)$/.test(lower) ||
    p.startsWith("docs/") ||
    /^(readme|license|changelog|authors|roadmap)(\.|$)/i.test(base)
  ) {
    return "docs";
  }

  if (/\.(css|scss|less|html|xml|json|ya?ml)$/.test(lower)) return "style";

  return "unknown";
}

/** Package name under `packages/<name>/`, or null. */
export function packageFromCiPath(filePath: string): string | null {
  const m = normalizeCiPath(filePath).match(/^packages\/([^/]+)\//);
  return m?.[1] ?? null;
}

export function isScopablePackage(name: string): name is ScopablePackage {
  return SCOPABLE_SET.has(name);
}

/** Scoped check name → human package id (`lint:core` → `core`). */
export function packageFromScopedCheck(check: string): ScopablePackage | null {
  const m = check.match(/^(?:lint|typecheck|test|build):(core|cli|extension)$/);
  return m ? (m[1] as ScopablePackage) : null;
}

export function isPackageScopedCheck(check: string): boolean {
  return packageFromScopedCheck(check) != null;
}

/** Join selection reasons for progress cards / one-line CLI. */
export function formatCiSelectionReason(reason: string | string[] | undefined): string {
  if (reason == null) return "";
  if (Array.isArray(reason)) return reason.filter(Boolean).join("; ");
  return reason;
}

function fullSuite(reasons: string[], paths: string[], uncertain: boolean): CiCheckSelection {
  const reason = reasons.length ? reasons : ["uncertain → full suite"];
  const mapping: CiCheckMapping[] = DEFAULT_CI_CHECKS.map((check) => ({
    check,
    reason: reason.join("; "),
  }));
  return {
    checks: [...DEFAULT_CI_CHECKS],
    reason,
    mapping,
    uncertain,
    changedPaths: paths,
    packageScoped: false,
  };
}

function packageSuiteChecks(pkgs: ScopablePackage[]): string[] {
  const checks: string[] = ["format:check"];
  for (const pkg of pkgs) {
    // Order: lint → typecheck → test per package so fail-fast stops that package suite first.
    checks.push(`lint:${pkg}`, `typecheck:${pkg}`, `test:${pkg}`);
  }
  return checks;
}

/**
 * Path-aware check selection for implementor preflight and shepherd/export.
 * Confident package mapping → scoped lint/typecheck/unit (never root `pnpm test`).
 * Uncertain mapping always returns the full configured suite with an explicit reason.
 */
export function selectCiChecks(changedPaths: string[]): CiCheckSelection {
  const paths = [...new Set(changedPaths.map(normalizeCiPath).filter(Boolean))];
  if (paths.length === 0) {
    return fullSuite(["no changed paths", "uncertain → full suite"], paths, true);
  }

  const kinds = paths.map(classifyCiPath);
  if (kinds.some((kind) => kind === "unknown")) {
    return fullSuite(["uncertain path mapping", "uncertain → full suite"], paths, true);
  }
  if (kinds.some((kind) => kind === "config")) {
    return fullSuite(["config/CI scripts changed; running full suite"], paths, false);
  }

  const onlyDocsOrStyle = kinds.every((kind) => kind === "docs" || kind === "style");
  if (onlyDocsOrStyle) {
    const reason = kinds.every((kind) => kind === "docs")
      ? ["docs/markdown-only → format:check", "skip units/lint/typecheck/build (confident)"]
      : ["docs/style-only → format:check", "skip units/lint/typecheck/build (confident)"];
    return {
      checks: ["format:check"],
      reason,
      mapping: [{ check: "format:check", reason: reason.join("; ") }],
      uncertain: false,
      changedPaths: paths,
      packageScoped: false,
    };
  }

  const codePaths = paths.filter((_, i) => kinds[i] === "source" || kinds[i] === "test");
  const pkgs = new Set<ScopablePackage>();
  let unscoping = false;
  for (const p of codePaths) {
    const name = packageFromCiPath(p);
    if (name && isScopablePackage(name)) {
      pkgs.add(name);
    } else {
      unscoping = true;
    }
  }

  if (unscoping || pkgs.size === 0) {
    return fullSuite(
      ["changed paths outside scopable packages/core|cli|extension", "uncertain → full suite"],
      paths,
      true,
    );
  }

  const ordered = SCOPABLE_PACKAGES.filter((p) => pkgs.has(p));
  const checks = packageSuiteChecks(ordered);
  const pkgList = ordered.map((p) => `packages/${p}/**`).join(" + ");
  const reason = [
    `${pkgList} → per-package format + lint + typecheck + unit tests`,
    "confident mapping — not full monorepo pnpm test",
    "fail-fast: stop after first package suite fail",
  ];
  const mapping: CiCheckMapping[] = checks.map((check) => {
    if (check === "format:check") {
      return { check, reason: "shared format check before package suites" };
    }
    const pkg = packageFromScopedCheck(check);
    return {
      check,
      reason: pkg ? `packages/${pkg}/** scoped ${check.split(":")[0]}` : reason.join("; "),
    };
  });

  return {
    checks,
    reason,
    mapping,
    uncertain: false,
    changedPaths: paths,
    packageScoped: true,
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
