import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
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

/**
 * Compute hash of all tracked files in the repository.
 * Uses git ls-tree to get the content hash of the index (same as what will be committed).
 * This is fast because it reads from git's object database, not the working tree.
 *
 * Fail-closed: If git ls-tree fails, we return null (cache miss).
 */
async function computeTrackedFilesHash(cwd: string): Promise<string | null> {
  try {
    // git ls-tree -r HEAD includes all tracked files with their blob SHAs
    // This gives us a deterministic, content-addressed view of the repository
    const { stdout } = await git(cwd, ["ls-tree", "-r", "HEAD"]);
    
    // Hash the entire ls-tree output (includes paths and blob SHAs)
    const hash = createHash("sha256");
    hash.update(stdout);
    return hash.digest("hex");
  } catch {
    // Not a git repo, no HEAD, or other error - fail closed with cache miss
    return null;
  }
}

/**
 * Compute hash of package.json scripts.
 * Changes to scripts should invalidate the cache.
 */
async function computeScriptsHash(cwd: string): Promise<string | null> {
  try {
    const pkgPath = path.join(cwd, "package.json");
    const content = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    
    // Hash the scripts object
    const hash = createHash("sha256");
    hash.update(JSON.stringify(pkg.scripts || {}));
    return hash.digest("hex");
  } catch {
    // No package.json or invalid - fail closed with cache miss
    return null;
  }
}

/**
 * Compute input hash for CI checks.
 * Combines:
 * - Hash of all tracked files (git ls-tree -r HEAD)
 * - Hash of package.json scripts (changes to CI commands invalidate cache)
 *
 * Returns null if we cannot compute a reliable hash (fail-closed: cache miss).
 */
export async function computeCiInputHash(cwd: string): Promise<string | null> {
  const [filesHash, scriptsHash] = await Promise.all([
    computeTrackedFilesHash(cwd),
    computeScriptsHash(cwd),
  ]);

  if (!filesHash || !scriptsHash) {
    return null;
  }

  // Combine hashes
  const hash = createHash("sha256");
  hash.update(filesHash);
  hash.update(scriptsHash);
  return hash.digest("hex");
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
): Promise<CiCacheEntry | null> {
  const currentHash = await computeCiInputHash(cwd);
  if (!currentHash) {
    // Cannot compute current hash - fail closed with cache miss
    return null;
  }

  const cache = await loadCiCache(cwd);
  const entry = cache.checks[check];

  if (!entry) {
    // No cached entry for this check
    return null;
  }

  if (entry.inputHash !== currentHash) {
    // Inputs changed - cache invalid
    return null;
  }

  // Cache hit!
  return entry;
}

/**
 * Record a successful check result in the cache.
 */
export async function recordCheckPass(cwd: string, check: string): Promise<void> {
  const inputHash = await computeCiInputHash(cwd);
  if (!inputHash) {
    // Cannot compute hash - don't cache (fail closed)
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
