import { existsSync } from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { isPluginBuildArtifact } from "./plugin-dirt.js";
import { getLocalPr, getLocalPrNameStatus, refreshLocalPrHead } from "./prs.js";

/** Default local CI suite names (legacy / host callers). Local run_ci never selects this full set (RAD-119). */
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
  /** Check names to run (`format:check`, `lint:core`, `test`, …). Empty when skipped. */
  checks: string[];
  /** Why this plan was chosen (print these; RAD-105 / RAD-119). */
  reason: string[];
  mapping: CiCheckMapping[];
  uncertain: boolean;
  changedPaths: string[];
  /** True when checks are per-package scoped (not root `pnpm test` / full suite). */
  packageScoped?: boolean;
  /** True when local CI is intentionally empty (printable skip — never silent). */
  skipped?: boolean;
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

/** Plugin manifest / MCP / hooks metadata — not monorepo toolchain config (RAD-119). */
const INCIDENTAL_PLUGIN_META = new Set(["plugin.json", "mcp.json", "hooks.json"]);

export function normalizeCiPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(filePath: string): string {
  const parts = normalizeCiPath(filePath).split("/");
  return parts[parts.length - 1] ?? filePath;
}

/** True for routine plugin packaging metadata that must not force config → full suite. */
export function isIncidentalPluginMeta(filePath: string): boolean {
  const p = normalizeCiPath(filePath);
  if (!p.startsWith("packages/plugin/")) return false;
  const base = basename(p);
  if (INCIDENTAL_PLUGIN_META.has(base)) return true;
  if (p.startsWith("packages/plugin/.cursor-plugin/")) return true;
  return false;
}

export function isPluginPackagePath(filePath: string): boolean {
  return normalizeCiPath(filePath).startsWith("packages/plugin/");
}

/** Classify one changed path for smart CI. Unknown → skip local CI (never silent; never full suite). */
export function classifyCiPath(filePath: string): CiPathKind {
  const p = normalizeCiPath(filePath);
  const base = basename(p);
  const lower = p.toLowerCase();

  // Incidental plugin manifests are format-able style, not hard toolchain config.
  if (isIncidentalPluginMeta(p)) {
    return "style";
  }

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

/**
 * Map CI-resume failing check names onto the smart plan.
 * When the plan is package-scoped, root `test`/`lint`/`typecheck` (from an older
 * full-suite gate) expand to the matching `*:core|cli|extension` checks so resume
 * does not force whole-monorepo `pnpm test`.
 * Skip plans never reinflate root suite names (RAD-119).
 */
export function expandFailingChecks(
  failingChecks: string[],
  selection: CiCheckSelection,
): string[] {
  const out: string[] = [];
  const rootSuite = new Set(["test", "lint", "typecheck", "build", "format:check"]);
  for (const raw of failingChecks) {
    const name = raw.trim();
    if (!name) continue;
    if (
      (selection.skipped === true || selection.checks.length === 0) &&
      rootSuite.has(name)
    ) {
      // Never reinflate full-suite names onto a skip plan.
      continue;
    }
    if (
      selection.packageScoped === true &&
      (name === "test" || name === "lint" || name === "typecheck")
    ) {
      const scoped = selection.checks.filter((c) => c === name || c.startsWith(`${name}:`));
      if (scoped.length > 0) {
        out.push(...scoped);
        continue;
      }
    }
    out.push(name);
  }
  return [...new Set(out)];
}

/**
 * RAD-117: confident package-scoped or docs/style-only plans format only changed
 * prettier-able paths (git blobs). Skip / uncertain keep format off the plan (empty checks).
 */
export function shouldScopeFormatCheck(selection: CiCheckSelection | undefined): boolean {
  if (!selection || selection.uncertain || selection.skipped) return false;
  if (selection.packageScoped === true) return true;
  return selection.checks.length === 1 && selection.checks[0] === "format:check";
}

/** Intentional empty plan — printable skip, never root `pnpm test` (RAD-119). */
function skipCi(reasons: string[], paths: string[], uncertain: boolean): CiCheckSelection {
  const reason = reasons.length
    ? reasons
    : ["unmappable paths → skip local CI", "never full monorepo pnpm test"];
  return {
    checks: [],
    reason,
    mapping: [],
    uncertain,
    changedPaths: paths,
    packageScoped: false,
    skipped: true,
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

function thinPluginSuite(paths: string[], extraReasons: string[] = []): CiCheckSelection {
  const reason = [
    "packages/plugin/** → thin plugin suite (format:check only)",
    "confident mapping — not full monorepo pnpm test",
    ...extraReasons,
  ];
  return {
    checks: ["format:check"],
    reason,
    mapping: [
      {
        check: "format:check",
        reason: `${reason.join("; ")}; scoped to changed prettier paths`,
      },
    ],
    uncertain: false,
    changedPaths: paths,
    packageScoped: false,
    skipped: false,
  };
}

function packageScopedSelection(pkgs: Set<ScopablePackage>, paths: string[]): CiCheckSelection {
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
      return {
        check,
        reason: "format:check scoped to changed prettier paths before package suites",
      };
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
    skipped: false,
  };
}

/** Root / repo-wide toolchain config (not package-local, not incidental plugin meta). */
export function isHardConfigPath(filePath: string): boolean {
  const p = normalizeCiPath(filePath);
  if (isIncidentalPluginMeta(p)) return false;
  if (classifyCiPath(p) !== "config") return false;
  const pkg = packageFromCiPath(p);
  // packages/core|cli|extension package.json / tsconfig → scope to that package.
  if (pkg && isScopablePackage(pkg)) return false;
  return true;
}

/** Package-local config under a scopable package contributes that package to the plan. */
function scopablePackageFromConfigPath(filePath: string): ScopablePackage | null {
  const p = normalizeCiPath(filePath);
  if (isIncidentalPluginMeta(p)) return null;
  if (classifyCiPath(p) !== "config") return null;
  const pkg = packageFromCiPath(p);
  if (pkg && isScopablePackage(pkg)) return pkg;
  return null;
}

/**
 * Path-aware check selection for implementor preflight and shepherd/export.
 * Confident package mapping → scoped lint/typecheck/unit (never root `pnpm test`).
 * Uncertain / hard-config mapping → skip with an explicit reason (RAD-119) — never full suite.
 */
export function selectCiChecks(changedPaths: string[]): CiCheckSelection {
  const paths = [...new Set(changedPaths.map(normalizeCiPath).filter(Boolean))];
  if (paths.length === 0) {
    return skipCi(
      [
        "no changed paths",
        "skip local CI — agent may run touched-package tests manually",
        "never full monorepo pnpm test",
      ],
      paths,
      true,
    );
  }

  const kinds = paths.map(classifyCiPath);
  if (kinds.some((kind) => kind === "unknown")) {
    return skipCi(
      [
        "uncertain path mapping",
        "skip local CI — agent may run touched-package tests manually",
        "never full monorepo pnpm test",
      ],
      paths,
      true,
    );
  }

  const hardConfig = paths.filter(isHardConfigPath);
  if (hardConfig.length > 0) {
    return skipCi(
      [
        "config/CI scripts changed; cannot confidently scope",
        "skip local CI — origin is the cleanliness bar; agent may run touched-package tests",
        "never full monorepo pnpm test",
      ],
      paths,
      false,
    );
  }

  const onlyDocsOrStyle = kinds.every((kind) => kind === "docs" || kind === "style");
  if (onlyDocsOrStyle) {
    const reason = kinds.every((kind) => kind === "docs")
      ? ["docs/markdown-only → format:check", "skip units/lint/typecheck/build (confident)"]
      : ["docs/style-only → format:check", "skip units/lint/typecheck/build (confident)"];
    return {
      checks: ["format:check"],
      reason,
      mapping: [
        {
          check: "format:check",
          reason: `${reason.join("; ")}; scoped to changed prettier paths`,
        },
      ],
      uncertain: false,
      changedPaths: paths,
      packageScoped: false,
      skipped: false,
    };
  }

  const pkgs = new Set<ScopablePackage>();
  let hasPluginWork = false;
  let onlyPluginArtifacts = true;
  let unscoping = false;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    const kind = kinds[i]!;

    const fromConfig = scopablePackageFromConfigPath(p);
    if (fromConfig) {
      pkgs.add(fromConfig);
      onlyPluginArtifacts = false;
      continue;
    }

    if (kind !== "source" && kind !== "test") {
      // docs/style (including incidental plugin meta) ride along with scoped plans.
      if (isPluginPackagePath(p) && !isPluginBuildArtifact(p)) {
        hasPluginWork = true;
        onlyPluginArtifacts = false;
      } else if (!isPluginBuildArtifact(p)) {
        onlyPluginArtifacts = false;
      }
      continue;
    }

    // Bundled plugin MCP/hooks outputs track core changes; they must not force unscoping.
    if (isPluginBuildArtifact(p)) continue;

    onlyPluginArtifacts = false;
    const name = packageFromCiPath(p);
    if (name && isScopablePackage(name)) {
      pkgs.add(name);
    } else if (isPluginPackagePath(p) || name === "plugin") {
      hasPluginWork = true;
    } else {
      unscoping = true;
    }
  }

  if (unscoping) {
    return skipCi(
      [
        "changed paths outside scopable packages/core|cli|extension",
        "skip local CI — agent may run touched-package tests manually",
        "never full monorepo pnpm test",
      ],
      paths,
      true,
    );
  }

  if (pkgs.size > 0) {
    return packageScopedSelection(pkgs, paths);
  }

  if (hasPluginWork) {
    return thinPluginSuite(paths);
  }

  // Build artifacts alone (or with docs/style) must not force a suite — format if anything prettier-able remains.
  const nonArtifactKinds = paths
    .filter((p) => !isPluginBuildArtifact(p))
    .map((p) => classifyCiPath(p));
  if (
    nonArtifactKinds.length > 0 &&
    nonArtifactKinds.every((kind) => kind === "docs" || kind === "style")
  ) {
    return {
      checks: ["format:check"],
      reason: [
        "docs/style (+ ignored plugin build artifacts) → format:check",
        "confident mapping — not full monorepo pnpm test",
      ],
      mapping: [
        {
          check: "format:check",
          reason: "format:check scoped to changed prettier paths",
        },
      ],
      uncertain: false,
      changedPaths: paths,
      packageScoped: false,
      skipped: false,
    };
  }

  if (onlyPluginArtifacts || nonArtifactKinds.length === 0) {
    return skipCi(
      [
        "plugin build artifacts only; no product package scope",
        "skip local CI — rebuild artifacts are not a local suite trigger",
        "never full monorepo pnpm test",
      ],
      paths,
      true,
    );
  }

  return skipCi(
    [
      "no scopable package changes",
      "skip local CI — agent may run touched-package tests manually",
      "never full monorepo pnpm test",
    ],
    paths,
    true,
  );
}

/** Normalize for plugin-install / worktree path compares (Windows-safe). */
function normCiPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * True when `cwd` is a Cursor plugin install (linked copy under ~/.cursor/plugins
 * or CURSOR_PLUGIN_ROOT) — not a workspace / loop worktree source of truth.
 */
export function isCursorPluginInstallPath(cwd: string): boolean {
  const normalized = normCiPath(cwd);
  if (normalized.includes("/.cursor/plugins/")) return true;
  const pluginRoot = process.env.CURSOR_PLUGIN_ROOT?.trim();
  if (!pluginRoot) return false;
  const root = normCiPath(pluginRoot);
  return normalized === root || normalized.startsWith(`${root}/`);
}

/**
 * Resolve the directory local CI must run in.
 * Live loops prefer `worktreePath`. A Cursor plugin-install cwd is never used
 * silently (RAD-112): redirect to the worktree, or refuse with a clear error.
 * Allowed only when the loop itself is editing that install path.
 */
export function resolveCiCwd(cwd: string, worktreePath: string | null | undefined): string {
  const worktreeOk = Boolean(worktreePath && existsSync(worktreePath));
  if (worktreeOk) {
    const wt = worktreePath as string;
    // After link-plugin/rebuild, still target the loop worktree unless this loop IS the install.
    if (isCursorPluginInstallPath(cwd) && normCiPath(cwd) !== normCiPath(wt)) {
      return wt;
    }
    return wt;
  }
  if (isCursorPluginInstallPath(cwd)) {
    throw new Error(
      `Refusing CI in Cursor plugin install (${cwd}): stale plugin build / wrong tree. ` +
        `run_ci must use the loop worktree (.loops/<id>) or the workspace git root — not the linked plugin copy.`,
    );
  }
  return cwd;
}

function addSplitPaths(set: Set<string>, raw: string): void {
  const parts = raw.split("\t").filter(Boolean);
  const file = parts[parts.length - 1];
  if (file) set.add(normalizeCiPath(file));
}

async function addDiffNameOnly(set: Set<string>, cwd: string, range: string): Promise<void> {
  const result = await git(cwd, ["diff", "--name-only", range], { allowFail: true });
  if (result.code !== 0) return;
  for (const line of result.stdout.split("\n")) {
    if (line.trim()) addSplitPaths(set, line.trim());
  }
}

/** Committed loop diff plus dirty/untracked files in cwd (implementor worktree). */
export async function changedPathsForCi(cwd: string, id?: string): Promise<string[]> {
  const paths = new Set<string>();
  if (id) {
    try {
      // Prefer refreshed loop name-status (base…head), then base…HEAD / baseRef…HEAD fallbacks.
      for (const file of await getLocalPrNameStatus(cwd, id)) {
        addSplitPaths(paths, file.path);
      }
      if (paths.size === 0) {
        const pr = await refreshLocalPrHead(cwd, id).catch(() => getLocalPr(cwd, id));
        await addDiffNameOnly(paths, cwd, `${pr.baseSha}...HEAD`);
        if (paths.size === 0 && pr.baseRef) {
          await addDiffNameOnly(paths, cwd, `${pr.baseRef}...HEAD`);
        }
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
