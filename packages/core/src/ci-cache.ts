import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import {
  eslintPathsFromChanged,
  hostScopeFailClosedReason,
  prettierPathsFromChanged,
  readPackageScripts,
} from "./ci-host-scope.js";
import {
  isScopablePackage,
  normalizeCiPath,
  packageFromScopedCheck,
  type CiCheckSelection,
  type ScopablePackage,
} from "./ci-select.js";
import { ciCheckCommand } from "./progress.js";
import { gitCommonDir, git } from "./git.js";

export interface CiCacheEntry {
  /** Hash of all inputs relevant to this check */
  inputHash: string;
  /** Timestamp when this check passed (ISO string) */
  passedAt: string;
  /** Check name (format:check, lint, typecheck, test, build) */
  check: string;
}

export interface CiCacheData {
  /** Map from check name to cache entry */
  checks: Record<string, CiCacheEntry>;
}

/** Scope inputs passed from ci-runner when resolving per-check cache keys (RAD-118). */
export interface CheckInputScopeOptions {
  changedPaths?: string[];
  formatScoped?: boolean;
  selection?: CiCheckSelection;
  testFiles?: readonly string[];
}

const ROOT_ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
];

const ROOT_TSCONFIGS = ["tsconfig.json", "tsconfig.base.json"];

/** Prettier config / ignore paths always hashed from disk (runner reads worktree, not index). */
const PRETTIER_WORKTREE_INPUTS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  ".prettierignore",
] as const;

function isPrettierWorktreeInput(relPath: string): boolean {
  const normalized = normalizeCiPath(relPath);
  const base = path.posix.basename(normalized);
  return (
    (PRETTIER_WORKTREE_INPUTS as readonly string[]).includes(base) ||
    base.startsWith(".prettierrc.")
  );
}

/** Map workspace dependency names in this monorepo to scopable package ids. */
function workspaceNameToScopablePackage(name: string): ScopablePackage | null {
  if (name === "@prgenie/core") return "core";
  if (name === "@prgenie/cli") return "cli";
  if (name === "prgenie" || name === "@prgenie/extension") return "extension";
  return null;
}

async function readWorkspaceDependencyPackages(
  cwd: string,
  pkg: ScopablePackage,
): Promise<ScopablePackage[] | null> {
  try {
    const raw = await readFile(path.join(cwd, "packages", pkg, "package.json"), "utf8");
    const json = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = new Set<ScopablePackage>();
    for (const section of [json.dependencies, json.devDependencies]) {
      if (!section) continue;
      for (const [name, spec] of Object.entries(section)) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const mapped = workspaceNameToScopablePackage(name);
        if (mapped && isScopablePackage(mapped)) deps.add(mapped);
      }
    }
    return [...deps];
  } catch {
    return null;
  }
}

async function collectPrettierWorktreeInputPaths(cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of PRETTIER_WORKTREE_INPUTS) {
    if (await pathExists(cwd, name)) out.push(name);
  }
  return out;
}

async function mergePathsUnderPrefixes(
  cwd: string,
  prefixes: Iterable<string>,
): Promise<string[] | null> {
  const allPaths = new Set<string>();
  for (const prefix of prefixes) {
    const collected = await collectPathsUnderPrefix(cwd, prefix);
    if (!collected) return null;
    for (const p of collected) allPaths.add(p);
  }
  return [...allPaths].sort();
}

/**
 * Get the directory for CI cache storage.
 * Stored in .git/agent-console/ci-cache/
 */
async function ciCacheDir(cwd: string): Promise<string> {
  const common = await gitCommonDir(cwd);
  const dir = path.join(common, "agent-console", "ci-cache");
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Get the CI cache file path.
 */
async function ciCacheFile(cwd: string): Promise<string> {
  const dir = await ciCacheDir(cwd);
  return path.join(dir, "cache.json");
}

/**
 * Load CI cache from disk.
 */
export async function loadCiCache(cwd: string): Promise<CiCacheData> {
  try {
    const file = await ciCacheFile(cwd);
    const content = await readFile(file, "utf8");
    return JSON.parse(content) as CiCacheData;
  } catch {
    // Cache file doesn't exist or is invalid - return empty cache
    return { checks: {} };
  }
}

/**
 * Save CI cache to disk.
 */
export async function saveCiCache(cwd: string, cache: CiCacheData): Promise<void> {
  const file = await ciCacheFile(cwd);
  await writeFile(file, JSON.stringify(cache, null, 2), "utf8");
}

async function pathExists(cwd: string, relPath: string): Promise<boolean> {
  try {
    await access(path.join(cwd, relPath));
    return true;
  } catch {
    return false;
  }
}

/** Source path for a sibling unit test (`foo.test.ts` → `foo.ts`). */
function siblingSourceFromTest(testPath: string): string | null {
  const p = normalizeCiPath(testPath);
  if (!/\.(test|spec)\.[cm]?[jt]sx?$/i.test(p)) return null;
  return p.replace(/\.(test|spec)\.([cm]?[jt]sx?)$/i, ".$2");
}

async function addGitPathListing(
  cwd: string,
  paths: Set<string>,
  args: string[],
): Promise<boolean> {
  const result = await git(cwd, args, { allowFail: true });
  if (result.code !== 0) return false;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) paths.add(normalizeCiPath(trimmed));
  }
  return true;
}

/**
 * Collect tracked, dirty, and untracked files under a repo-relative prefix.
 * Fail-closed: returns null when git listing fails.
 */
async function collectPathsUnderPrefix(cwd: string, prefix: string): Promise<string[] | null> {
  const paths = new Set<string>();
  const normalizedPrefix = prefix ? normalizeCiPath(prefix) : "";
  const pathArgs = normalizedPrefix ? ["--", normalizedPrefix] : [];

  const okTracked = await addGitPathListing(cwd, paths, [
    "ls-files",
    "--exclude-standard",
    ...pathArgs,
  ]);
  if (!okTracked) return null;

  for (const cmd of [
    ["diff", "--name-only", "HEAD", ...pathArgs],
    ["diff", "--name-only", "--cached", ...pathArgs],
    ["ls-files", "-o", "--exclude-standard", ...pathArgs],
  ]) {
    const ok = await addGitPathListing(cwd, paths, cmd);
    if (!ok) return null;
  }

  return [...paths].sort();
}

async function collectExistingRootConfigs(cwd: string, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    if (await pathExists(cwd, name)) out.push(name);
  }
  return out;
}

async function collectFormatInputPaths(
  cwd: string,
  changedPaths: string[],
  formatScoped: boolean,
): Promise<string[] | null> {
  const worktreeInputs = await collectPrettierWorktreeInputPaths(cwd);
  let sourcePaths: string[] | null;

  if (formatScoped) {
    const candidates = prettierPathsFromChanged(changedPaths);
    if (candidates.length === 0) {
      sourcePaths = [];
    } else {
      const paths = new Set<string>();
      const okTracked = await addGitPathListing(cwd, paths, [
        "ls-files",
        "--exclude-standard",
        "--",
        ...candidates,
      ]);
      if (!okTracked) return null;

      for (const candidate of candidates) {
        if (paths.has(candidate)) continue;
        if (await pathExists(cwd, candidate)) paths.add(candidate);
      }
      sourcePaths = [...paths].sort();
    }
  } else {
    sourcePaths = await collectPathsUnderPrefix(cwd, "");
  }

  if (sourcePaths == null) return null;
  return [...new Set([...sourcePaths, ...worktreeInputs])].sort();
}

async function collectExplicitInputPaths(
  cwd: string,
  relPaths: string[],
): Promise<string[] | null> {
  const paths = new Set<string>();
  for (const rel of relPaths.map(normalizeCiPath).filter(Boolean)) {
    if (await pathExists(cwd, rel)) {
      paths.add(rel);
      continue;
    }
    const ok = await addGitPathListing(cwd, paths, ["ls-files", "--exclude-standard", "--", rel]);
    if (!ok) return null;
    if (paths.has(rel)) continue;
    // Deleted tracked file still in index — include so hash reflects removal.
    const tracked = await git(cwd, ["ls-files", "--exclude-standard", "--", rel], {
      allowFail: true,
    });
    if (tracked.code === 0 && tracked.stdout.trim()) paths.add(rel);
  }
  return [...paths].sort();
}

/**
 * Resolve the repo-relative paths whose content affects a CI check.
 * Safe over-approximations are documented in docs/ci-checks.md (RAD-118).
 * Fail-closed: returns null when scope cannot be determined reliably.
 */
export async function resolveCheckInputPaths(
  cwd: string,
  check: string,
  options: CheckInputScopeOptions = {},
): Promise<string[] | null> {
  const changedPaths = options.changedPaths ?? options.selection?.changedPaths ?? [];

  if (check === "format:check") {
    return collectFormatInputPaths(cwd, changedPaths, options.formatScoped === true);
  }

  const pkg = packageFromScopedCheck(check);
  if (pkg) {
    const prefix = `packages/${pkg}/`;
    const needsWorkspaceDeps =
      check.startsWith("typecheck:") || check.startsWith("test:") || check.startsWith("build:");

    if (check.startsWith("test:")) {
      const scoped = options.testFiles ?? options.selection?.testFiles?.[check] ?? undefined;
      if (scoped && scoped.length > 0) {
        const explicit = new Set<string>([`${prefix}package.json`, `${prefix}tsconfig.json`]);
        for (const testFile of scoped) {
          explicit.add(normalizeCiPath(testFile));
          const src = siblingSourceFromTest(testFile);
          if (src) explicit.add(src);
        }
        const explicitPaths = await collectExplicitInputPaths(cwd, [...explicit]);
        if (!explicitPaths) return null;
        const deps = await readWorkspaceDependencyPackages(cwd, pkg);
        if (deps === null) return null;
        const prefixes = deps.map((dep) => `packages/${dep}/`);
        const depPaths = await mergePathsUnderPrefixes(cwd, prefixes);
        if (!depPaths) return null;
        return [...new Set([...explicitPaths, ...depPaths])].sort();
      }
    }

    const prefixes = new Set<string>([prefix]);
    if (needsWorkspaceDeps) {
      const deps = await readWorkspaceDependencyPackages(cwd, pkg);
      if (deps === null) return null;
      for (const dep of deps) prefixes.add(`packages/${dep}/`);
    }

    const packagePaths = await mergePathsUnderPrefixes(cwd, prefixes);
    if (!packagePaths) return null;

    const extra: string[] = [];
    if (check.startsWith("lint:")) {
      extra.push(...(await collectExistingRootConfigs(cwd, ROOT_ESLINT_CONFIGS)));
    }
    if (check.startsWith("typecheck:")) {
      extra.push(...(await collectExistingRootConfigs(cwd, ROOT_TSCONFIGS)));
    }
    if (check.startsWith("build:") && (await pathExists(cwd, "scripts/build.mjs"))) {
      extra.push("scripts/build.mjs");
    }
    return [...new Set([...packagePaths, ...extra])].sort();
  }

  const failClosed = hostScopeFailClosedReason(changedPaths);
  if (!failClosed && check === "lint") {
    const eslintPaths = eslintPathsFromChanged(changedPaths);
    if (eslintPaths.length > 0) {
      const configs = await collectExistingRootConfigs(cwd, ROOT_ESLINT_CONFIGS);
      return [...new Set([...eslintPaths, ...configs, "package.json"])].sort();
    }
  }

  // Unknown / full-script checks — over-approximate to the whole worktree (never false green).
  return collectPathsUnderPrefix(cwd, "");
}

/**
 * Hash one file's effective content for cache invalidation.
 * format:check uses git index blobs (matches the blob runner); other checks use disk bytes.
 */
async function hashFileContent(
  cwd: string,
  relPath: string,
  check: string,
): Promise<string | null> {
  const normalized = normalizeCiPath(relPath);

  if (check === "format:check" && !isPrettierWorktreeInput(normalized)) {
    const blob = await git(cwd, ["show", `:${normalized.replace(/"/g, '\\"')}`], {
      allowFail: true,
    });
    if (blob.code === 0) {
      const hash = createHash("sha256");
      hash.update(normalized);
      hash.update("\0");
      hash.update(blob.stdout);
      return hash.digest("hex");
    }
  }

  try {
    const content = await readFile(path.join(cwd, normalized));
    const hash = createHash("sha256");
    hash.update(normalized);
    hash.update("\0");
    hash.update(content);
    return hash.digest("hex");
  } catch {
    // Tracked-but-deleted on disk — still affects lint/test.
    const tracked = await git(cwd, ["ls-files", "--error-unmatch", normalized], {
      allowFail: true,
    });
    if (tracked.code === 0) {
      const hash = createHash("sha256");
      hash.update(normalized);
      hash.update("\0");
      hash.update("DELETED");
      return hash.digest("hex");
    }
    return null;
  }
}

async function hashInputPaths(cwd: string, check: string, paths: string[]): Promise<string | null> {
  const hash = createHash("sha256");
  for (const relPath of paths) {
    const fileHash = await hashFileContent(cwd, relPath, check);
    if (!fileHash) return null;
    hash.update(relPath);
    hash.update("\0");
    hash.update(fileHash);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Hash the script/config surface a check depends on (working tree, not HEAD-only).
 * Fail-closed when required inputs are unreadable.
 */
async function computeCheckScriptsHash(
  cwd: string,
  check: string,
  options: CheckInputScopeOptions,
): Promise<string | null> {
  const hash = createHash("sha256");
  const rootScripts = readPackageScripts(cwd);
  if (!rootScripts) return null;

  const pkg = packageFromScopedCheck(check);
  if (pkg) {
    const scopedTestFiles =
      options.testFiles ??
      (check.startsWith("test:") ? options.selection?.testFiles?.[check] : undefined);
    hash.update(ciCheckCommand(check, scopedTestFiles));
    hash.update("\0");
    try {
      const pkgJson = await readFile(path.join(cwd, "packages", pkg, "package.json"), "utf8");
      hash.update(pkgJson);
    } catch {
      return null;
    }
    return hash.digest("hex");
  }

  const script = rootScripts[check];
  if (script == null) {
    hash.update(`missing-script:${check}`);
  } else {
    hash.update(script);
  }
  return hash.digest("hex");
}

/**
 * Compute per-check input hash from worktree content in that check's scope (RAD-118).
 * Returns null if we cannot compute a reliable hash (fail-closed: cache miss).
 */
export async function computeCheckInputHash(
  cwd: string,
  check: string,
  options: CheckInputScopeOptions = {},
): Promise<string | null> {
  const paths = await resolveCheckInputPaths(cwd, check, options);
  if (paths == null) return null;

  const [filesHash, scriptsHash] = await Promise.all([
    hashInputPaths(cwd, check, paths),
    computeCheckScriptsHash(cwd, check, options),
  ]);

  if (!filesHash || !scriptsHash) return null;

  const hash = createHash("sha256");
  hash.update(filesHash);
  hash.update(scriptsHash);
  hash.update(check);
  return hash.digest("hex");
}

/**
 * Legacy full-tree hash (tests). Delegates to per-check scope for `lint` over the repo.
 * @deprecated Prefer {@link computeCheckInputHash} with an explicit check name.
 */
export async function computeCiInputHash(cwd: string): Promise<string | null> {
  return computeCheckInputHash(cwd, "lint", {});
}

/**
 * Check if a cached result is valid for a given check.
 * Returns the cached entry if valid, null otherwise.
 *
 * Fail-closed: Any uncertainty (missing hash, hash mismatch, etc.) returns null.
 */
export async function getCachedResult(
  cwd: string,
  check: string,
  options: CheckInputScopeOptions = {},
): Promise<CiCacheEntry | null> {
  const currentHash = await computeCheckInputHash(cwd, check, options);
  if (!currentHash) {
    return null;
  }

  const cache = await loadCiCache(cwd);
  const entry = cache.checks[check];

  if (!entry) {
    return null;
  }

  if (entry.inputHash !== currentHash) {
    return null;
  }

  return entry;
}

/**
 * Record a successful check result in the cache.
 */
export async function recordCheckPass(
  cwd: string,
  check: string,
  options: CheckInputScopeOptions = {},
): Promise<void> {
  const inputHash = await computeCheckInputHash(cwd, check, options);
  if (!inputHash) {
    return;
  }

  const cache = await loadCiCache(cwd);
  cache.checks[check] = {
    inputHash,
    passedAt: new Date().toISOString(),
    check,
  };
  await saveCiCache(cwd, cache);
}

/**
 * Clear all cached results (for testing or manual invalidation).
 */
export async function clearCiCache(cwd: string): Promise<void> {
  await saveCiCache(cwd, { checks: {} });
}
