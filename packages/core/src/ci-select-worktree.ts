import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { findGitRoot, git } from "./git.js";
import {
  normalizeCiPath,
  selectCiChecks,
  DEFAULT_CI_CHECKS,
  type CiCheckSelection,
  type SelectCiChecksOptions,
} from "./ci-select.js";
import { loopWorktreeIdentity } from "./worktrees.js";

/** Paths whose edits change CI selection / runner behavior (RAD-123). */
const CI_SELECTION_SOURCE_SUFFIXES = [
  "/packages/core/src/ci-select.ts",
  "/packages/core/src/ci-select.test.ts",
  "/packages/core/src/ci-select-worktree.ts",
  "/packages/core/src/ci-select-worktree.test.ts",
  "/packages/core/src/ci-runner.ts",
  "/packages/core/src/ci-runner.test.ts",
] as const;

export function isCiSelectionSourcePath(filePath: string): boolean {
  const p = `/${normalizeCiPath(filePath)}`;
  return CI_SELECTION_SOURCE_SUFFIXES.some((suffix) => p.endsWith(suffix) || p === suffix);
}

export function touchesCiSelectionSource(changedPaths: string[]): boolean {
  return changedPaths.some(isCiSelectionSourcePath);
}

export function worktreeCiSelectModulePath(worktreePath: string): string {
  return path.join(worktreePath, "packages", "core", "src", "ci-select.ts");
}

export function ciSelectionPlansEqual(a: CiCheckSelection, b: CiCheckSelection): boolean {
  // Flag drift (skipped / uncertain / packageScoped) changes runner behavior even when
  // checks + reason text match — treat as divergence so worktree wins (RAD-123).
  // RAD-127: testFiles drift changes which unit files run.
  return (
    JSON.stringify(a.checks) === JSON.stringify(b.checks) &&
    JSON.stringify([...a.reason].sort()) === JSON.stringify([...b.reason].sort()) &&
    JSON.stringify(a.testFiles ?? null) === JSON.stringify(b.testFiles ?? null) &&
    Boolean(a.skipped) === Boolean(b.skipped) &&
    Boolean(a.uncertain) === Boolean(b.uncertain) &&
    Boolean(a.packageScoped) === Boolean(b.packageScoped)
  );
}

export type CiSelectFn = (
  changedPaths: string[],
  options?: SelectCiChecksOptions,
) => CiCheckSelection;

export type ResolveCiSelectionResult = {
  selection: CiCheckSelection;
  /** Where the gating plan came from (RAD-167-R1). */
  source: "installed" | "worktree" | "base";
  /** True when gating plan and loop worktree selector disagree (RAD-167-R2). */
  diverged: boolean;
  /** Loud dogfood warning when plans diverge (also mirrored on stderr). */
  warning?: string;
  /** Worktree selector plan when it differs from the gate (advisory only). */
  advisorySelection?: CiCheckSelection;
};

export type ResolveCiSelectionOptions = {
  changedPaths: string[];
  worktreePath?: string | null;
  /** In-memory / installed-plugin selector (injectable for tests). */
  installedSelect?: CiSelectFn;
  /** Override worktree module loader (injectable for tests). */
  loadWorktreeSelect?: (worktreePath: string) => Promise<CiSelectFn | null>;
  /**
   * When the diff touches ci-select/ci-runner and the worktree module cannot be
   * loaded, throw instead of silently using the installed plugin (default true).
   */
  refuseStaleOnTouch?: boolean;
  /** Primary checkout override for resolving `tsx` (tests). */
  primaryPath?: string | null;
  /** Loop base branch ref for gating selector (RAD-167-R1). */
  baseRef?: string | null;
  /** Injectable loader for base-ref selectCiChecks (tests). */
  loadBaseRefSelect?: (
    gitRoot: string,
    baseRef: string,
    primaryPath?: string | null,
  ) => Promise<CiSelectFn | null>;
};

/** True when the repo root package.json names PR Genie (RAD-167-R3). */
export function isPrGenieRepo(cwd: string): boolean {
  try {
    const pkgPath = path.join(path.resolve(cwd), "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name === "prgenie";
  } catch {
    return false;
  }
}

type CacheEntry = { mtimeMs: number; select: CiSelectFn };
const worktreeSelectCache = new Map<string, CacheEntry>();
type BaseSelectCacheEntry = { select: CiSelectFn; tempWt: string; gitRoot: string };
const baseSelectCache = new Map<string, BaseSelectCacheEntry>();
/** Detached checkouts created for base ci-select and not yet released (RAD-167-R1). */
const baseWorktreesInUse = new Set<string>();
const BASE_WT_DIR_PREFIX = "prgenie-base-wt-";

function baseSelectCacheKey(gitRoot: string, baseSha: string): string {
  return `${path.resolve(gitRoot)}:${baseSha}`;
}

function markBaseWorktreeInUse(tempWt: string): void {
  baseWorktreesInUse.add(path.resolve(tempWt));
  baseWorktreesInUse.add(realPathOrResolve(tempWt));
}

function unmarkBaseWorktreeInUse(tempWt: string): void {
  baseWorktreesInUse.delete(path.resolve(tempWt));
  baseWorktreesInUse.delete(realPathOrResolve(tempWt));
}

function realPathOrResolve(filePath: string): string {
  try {
    // native expands Windows 8.3 names (`BRETTH~1` → `BrettHumphreys`).
    return realpathSync.native(filePath);
  } catch {
    try {
      return realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }
}

/** True for this process's temp base checkouts (`prgenie-base-wt-*` under tmpdir). */
function isTempBaseWorktreePath(worktreePath: string): boolean {
  if (!path.basename(worktreePath).startsWith(BASE_WT_DIR_PREFIX)) return false;
  // tmpdir() may be an 8.3 path (`BRETTH~1`) while git lists the long path.
  const rel = path.relative(realPathOrResolve(tmpdir()), realPathOrResolve(worktreePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function removeBaseWorktreeSync(gitRoot: string, tempWt: string): void {
  unmarkBaseWorktreeInUse(tempWt);
  worktreeSelectCache.delete(path.resolve(tempWt));
  spawnSync("git", ["-C", gitRoot, "worktree", "remove", "--force", tempWt], {
    windowsHide: true,
  });
  try {
    rmSync(tempWt, { recursive: true, force: true });
  } catch {
    // directory may already be gone
  }
  spawnSync("git", ["-C", gitRoot, "worktree", "prune"], { windowsHide: true });
}

function dropBaseSelectCacheEntry(cacheKey: string): void {
  const entry = baseSelectCache.get(cacheKey);
  if (!entry) return;
  baseSelectCache.delete(cacheKey);
  removeBaseWorktreeSync(entry.gitRoot, entry.tempWt);
}

/**
 * Drop stale temp base checkouts for this repo before adding another (RAD-167-R1).
 * `git worktree prune` clears admin entries whose directories are already gone.
 * Live `prgenie-base-wt-*` dirs under tmpdir that this process is not using are removed.
 */
function pruneOrphanBaseWorktrees(gitRoot: string): void {
  const root = path.resolve(gitRoot);
  spawnSync("git", ["-C", root, "worktree", "prune"], { windowsHide: true });
  const listed = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0 || !listed.stdout) return;
  const rootReal = realPathOrResolve(gitRoot);
  const cached = new Set(
    [...baseSelectCache.values()]
      .filter((entry) => realPathOrResolve(entry.gitRoot) === rootReal)
      .flatMap((entry) => [path.resolve(entry.tempWt), realPathOrResolve(entry.tempWt)]),
  );
  const orphans: string[] = [];
  for (const line of String(listed.stdout).split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length).trim();
    if (!isTempBaseWorktreePath(wt)) continue;
    const resolved = realPathOrResolve(wt);
    if (
      cached.has(resolved) ||
      cached.has(path.resolve(wt)) ||
      baseWorktreesInUse.has(resolved) ||
      baseWorktreesInUse.has(path.resolve(wt))
    ) {
      continue;
    }
    orphans.push(wt);
  }
  for (const wt of orphans) {
    removeBaseWorktreeSync(root, wt);
  }
}

/** Test helper — clear the worktree selector cache. */
export function clearWorktreeCiSelectCache(): void {
  worktreeSelectCache.clear();
  for (const key of [...baseSelectCache.keys()]) {
    dropBaseSelectCacheEntry(key);
  }
}

function warnLoud(message: string): void {
  try {
    process.stderr.write(`[prgenie] ${message}\n`);
  } catch {
    // ignore
  }
}

/** Short branch name for `main`-style loop bases (RAD-167-R1). */
function ciGateBaseShortName(baseRef: string): string {
  const trimmed = baseRef.trim();
  if (trimmed.startsWith("refs/remotes/origin/")) {
    return trimmed.slice("refs/remotes/origin/".length);
  }
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  if (trimmed.startsWith("origin/")) {
    return trimmed.slice("origin/".length);
  }
  return trimmed;
}

/**
 * Resolve the loop base for ci-select gating (RAD-167-R1).
 * Order: `<baseRef>`, `origin/<short>`, `refs/remotes/origin/<short>`.
 */
export async function resolveCiGateBaseRef(
  gitRoot: string,
  baseRef: string,
): Promise<{ ref: string; sha: string; tried: string[] } | null> {
  const trimmed = baseRef.trim();
  if (!trimmed) return null;
  const short = ciGateBaseShortName(trimmed);
  const candidates = [
    trimmed,
    ...(trimmed !== `origin/${short}` ? [`origin/${short}`] : []),
    ...(trimmed !== `refs/remotes/origin/${short}` ? [`refs/remotes/origin/${short}`] : []),
  ];
  const tried: string[] = [];
  for (const ref of candidates) {
    if (tried.includes(ref)) continue;
    tried.push(ref);
    const resolved = await git(gitRoot, ["rev-parse", ref], { allowFail: true });
    if (resolved.code === 0) {
      return { ref, sha: resolved.stdout.trim(), tried };
    }
  }
  return null;
}

export function formatCiGateBaseRefResolutionFailure(baseRef: string, tried: string[]): string {
  return (
    `RAD-167-R1: could not resolve loop base ref "${baseRef.trim()}" ` +
    `(tried, in order: ${tried.join(", ")}). ` +
    `Export/run_ci must evaluate selectCiChecks from the loop base; refusing silent installed fallback.`
  );
}

async function resolveTsxSearchRoots(
  worktreePath: string,
  primaryOverride?: string | null,
): Promise<string[]> {
  const roots: string[] = [];
  const add = (p: string | null | undefined) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (!existsSync(resolved)) return;
    if (!roots.some((r) => path.resolve(r) === resolved)) roots.push(resolved);
  };
  add(worktreePath);
  if (primaryOverride) add(primaryOverride);
  const ident = loopWorktreeIdentity(worktreePath);
  if (ident?.primaryPath) add(ident.primaryPath);
  add(process.cwd());
  return roots;
}

async function loadTsxApi(
  worktreePath: string,
  primaryOverride?: string | null,
): Promise<{
  tsImport: (specifier: string, parent: string) => Promise<Record<string, unknown>>;
} | null> {
  for (const root of await resolveTsxSearchRoots(worktreePath, primaryOverride)) {
    try {
      const req = createRequire(path.join(root, "package.json"));
      const apiPath = req.resolve("tsx/esm/api");
      const api = (await import(pathToFileURL(apiPath).href)) as {
        tsImport?: (specifier: string, parent: string) => Promise<Record<string, unknown>>;
      };
      if (typeof api.tsImport === "function") {
        return { tsImport: api.tsImport };
      }
    } catch {
      // try next root
    }
  }
  return null;
}

function resolveTsxCli(searchRoots: string[]): string | null {
  for (const root of searchRoots) {
    try {
      const req = createRequire(path.join(root, "package.json"));
      return req.resolve("tsx/cli");
    } catch {
      const candidate = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function spawnCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function selectViaTsxCliSync(
  tsxCli: string,
  modulePath: string,
  worktreePath: string,
  changedPaths: string[],
): CiCheckSelection {
  const dir = mkdtempSync(path.join(tmpdir(), "prgenie-ci-sel-"));
  const runPath = path.join(dir, "eval-ci-select.mts");
  writeFileSync(
    runPath,
    `import { pathToFileURL } from "node:url";
async function main() {
  const m = await import(pathToFileURL(process.argv[2]).href);
  const paths = JSON.parse(process.argv[3]);
  process.stdout.write(JSON.stringify(m.selectCiChecks(paths, { cwd: process.cwd() })));
}
main().catch((e) => { console.error(e); process.exit(1); });
`,
    "utf8",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [tsxCli, runPath, modulePath, JSON.stringify(changedPaths)],
      { encoding: "utf8", cwd: worktreePath, windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(
        `tsx worktree ci-select failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`,
      );
    }
    return JSON.parse(String(result.stdout)) as CiCheckSelection;
  } finally {
    try {
      unlinkSync(runPath);
    } catch {
      // ignore
    }
  }
}

export type LoadWorktreeSelectOptions = {
  /** Primary checkout override for resolving `tsx` (tests / plugin cwd). */
  primaryPath?: string | null;
  /**
   * Injectable for tests: when set, used instead of `loadTsxApi().tsImport`.
   * Throw (e.g. "The service is no longer running") to exercise CLI fallback.
   */
  tsImport?: (specifier: string, parent: string) => Promise<Record<string, unknown>>;
  /**
   * Skip in-process tsImport and eval via the tsx CLI. Used for the detached
   * base checkout so the parent does not lock those files (RAD-167-R1).
   */
  cliOnly?: boolean;
};

/**
 * Load `selectCiChecks` from the loop worktree source (not the installed plugin).
 * Prefers in-process `tsx` `tsImport`; falls back to a one-shot `tsx` CLI eval
 * when the API is missing **or** when `tsImport` throws (dead tsx service).
 * Never caches a failed in-process import.
 */
export async function loadWorktreeSelectCiChecks(
  worktreePath: string,
  options: LoadWorktreeSelectOptions = {},
): Promise<CiSelectFn | null> {
  const modulePath = worktreeCiSelectModulePath(worktreePath);
  if (!existsSync(modulePath)) return null;

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(modulePath)).mtimeMs;
  } catch {
    return null;
  }

  const cacheKey = path.resolve(worktreePath);
  const cached = worktreeSelectCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs) return cached.select;

  let tsImportFn = options.cliOnly ? undefined : options.tsImport;
  if (!options.cliOnly && !tsImportFn) {
    const api = await loadTsxApi(worktreePath, options.primaryPath);
    if (api) tsImportFn = api.tsImport;
  }

  if (!options.cliOnly && tsImportFn) {
    try {
      const parent = pathToFileURL(path.join(worktreePath, "package.json")).href;
      const mod = await tsImportFn(pathToFileURL(modulePath).href, parent);
      const select = mod.selectCiChecks;
      if (typeof select !== "function") {
        throw new Error(
          `Worktree ci-select at ${modulePath} did not export selectCiChecks (keys: ${Object.keys(mod).join(", ")})`,
        );
      }
      const rawSelect = select as (
        changedPaths: string[],
        options?: SelectCiChecksOptions,
      ) => CiCheckSelection;
      const fn: CiSelectFn = (changedPaths, selectOptions) =>
        rawSelect(changedPaths, { cwd: worktreePath, ...selectOptions });
      worktreeSelectCache.set(cacheKey, { mtimeMs, select: fn });
      return fn;
    } catch (err) {
      // Dead / crashed tsx service must not refuse the gate — fall through to CLI.
      // Do not cache the failure (mtime cache only stores successful selects).
      const detail = err instanceof Error ? err.message : String(err);
      warnLoud(
        `RAD-123: in-process tsImport failed (${detail}); falling back to tsx CLI for worktree ci-select`,
      );
    }
  }

  const roots = await resolveTsxSearchRoots(worktreePath, options.primaryPath);
  const tsxCli = resolveTsxCli(roots);
  if (!tsxCli) return null;

  const cliSelect: CiSelectFn = (changedPaths) =>
    selectViaTsxCliSync(tsxCli, modulePath, worktreePath, changedPaths);
  worktreeSelectCache.set(cacheKey, { mtimeMs, select: cliSelect });
  return cliSelect;
}

/**
 * Async CLI eval used when tests want a pure-async load without sync spawn.
 */
export async function selectCiChecksViaTsxCli(
  worktreePath: string,
  changedPaths: string[],
  options: { primaryPath?: string | null } = {},
): Promise<CiCheckSelection> {
  const modulePath = worktreeCiSelectModulePath(worktreePath);
  const roots = await resolveTsxSearchRoots(worktreePath, options.primaryPath);
  const tsxCli = resolveTsxCli(roots);
  if (!tsxCli) {
    throw new Error(`Cannot resolve tsx to load worktree ci-select from ${worktreePath}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), "prgenie-ci-sel-"));
  const runPath = path.join(dir, "eval-ci-select.mts");
  await writeFile(
    runPath,
    `import { pathToFileURL } from "node:url";
async function main() {
  const m = await import(pathToFileURL(process.argv[2]).href);
  const paths = JSON.parse(process.argv[3]);
  process.stdout.write(JSON.stringify(m.selectCiChecks(paths, { cwd: process.cwd() })));
}
main().catch((e) => { console.error(e); process.exit(1); });
`,
    "utf8",
  );
  try {
    const result = await spawnCapture(
      process.execPath,
      [tsxCli, runPath, modulePath, JSON.stringify(changedPaths)],
      worktreePath,
    );
    if (result.code !== 0) {
      throw new Error(`tsx worktree ci-select failed (${result.code}): ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout) as CiCheckSelection;
  } finally {
    await unlink(runPath).catch(() => undefined);
  }
}

function withBaseGateProvenance(
  selection: CiCheckSelection,
  diverged: boolean,
  advisory?: CiCheckSelection,
): CiCheckSelection {
  const stamp = diverged
    ? "RAD-167-R1: export gate uses base-commit ci-select (worktree differs — advisory below)"
    : "RAD-167-R1: export gate uses base-commit ci-select";
  const reason = selection.reason.includes(stamp) ? selection.reason : [stamp, ...selection.reason];
  if (diverged && advisory) {
    reason.push(
      `RAD-167-R2 advisory worktree plan: checks=${JSON.stringify(advisory.checks)} reason=${JSON.stringify(advisory.reason)}`,
    );
  }
  return { ...selection, reason };
}

/**
 * Load selectCiChecks from the loop base branch via a short-lived detached worktree (RAD-167-R1).
 */
export async function loadBaseRefSelectCiChecks(
  gitRoot: string,
  baseRef: string,
  primaryPath?: string | null,
  worktreeLoadOptions: LoadWorktreeSelectOptions = {},
): Promise<CiSelectFn | null> {
  const resolvedRef = await resolveCiGateBaseRef(gitRoot, baseRef);
  if (!resolvedRef) {
    const short = ciGateBaseShortName(baseRef);
    const tried = [baseRef.trim(), `origin/${short}`, `refs/remotes/origin/${short}`];
    warnLoud(formatCiGateBaseRefResolutionFailure(baseRef, tried));
    return null;
  }
  const checkoutRef = resolvedRef.ref;
  const baseSha = resolvedRef.sha;
  const cacheKey = baseSelectCacheKey(gitRoot, baseSha);
  const cached = baseSelectCache.get(cacheKey);
  if (cached) return cached.select;

  // RAD-167-R1: reap leaked prgenie-base-wt-* checkouts before adding another.
  pruneOrphanBaseWorktrees(gitRoot);

  const tempWt = mkdtempSync(path.join(tmpdir(), BASE_WT_DIR_PREFIX));
  markBaseWorktreeInUse(tempWt);
  const add = spawnSync(
    "git",
    ["-C", gitRoot, "worktree", "add", "--detach", tempWt, checkoutRef],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (add.status !== 0) {
    removeBaseWorktreeSync(gitRoot, tempWt);
    return null;
  }
  const select = await loadWorktreeSelectCiChecks(tempWt, {
    primaryPath,
    ...worktreeLoadOptions,
    // In-process import locks the checkout on Windows, so worktree remove fails.
    // CLI eval reads ci-select.ts in a child and exits before we delete (167-R1).
    // An injected throwing tsImport still exercises that fallback.
    cliOnly: worktreeLoadOptions.tsImport ? false : true,
  });
  if (!select) {
    removeBaseWorktreeSync(gitRoot, tempWt);
    return null;
  }
  // Keep the checkout until the plan is computed so tsx CLI fallback can read
  // ci-select.ts. resolveCiSelection releases it immediately after that call (167-R1).
  baseSelectCache.set(cacheKey, { select, tempWt, gitRoot });
  return select;
}

/**
 * True when a plan looks like the pre-RAD-119 / stale-plugin root suite that
 * dogfood must never run or peer-replay locally.
 *
 * Matches the classic reason string and/or exact `DEFAULT_CI_CHECKS` without a
 * modern scoped/skip/fixture stamp. Does **not** flag caller-forced test
 * fixtures that use root check names with an explicit fixture reason.
 */
export function looksLikeStaleFullSuitePlan(
  selection: Pick<CiCheckSelection, "checks" | "reason"> | { checks?: string[]; reason?: string[] },
): boolean {
  const checks = selection.checks ?? [];
  const reasons = selection.reason ?? [];
  if (
    reasons.some((r) =>
      /source\/test changed — format,\s*lint,\s*typecheck,\s*test,\s*build/i.test(r),
    )
  ) {
    return true;
  }
  const isDefaultSuite =
    checks.length === DEFAULT_CI_CHECKS.length &&
    DEFAULT_CI_CHECKS.every((c, i) => checks[i] === c);
  if (!isDefaultSuite) return false;
  // Exact default suite, but stamped as fixture / RAD-119 skip / worktree — not dogfood stale.
  if (
    reasons.some((r) =>
      /fixture|RAD-123|RAD-154|worktree ci-select|per-package|confident mapping|skip local CI|caller-forced/i.test(
        r,
      ),
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve the CI plan for a loop (RAD-123 / RAD-167).
 * PR Genie dogfood: gate on base-commit ci-select; worktree selector is advisory only.
 * Other repos: installed plugin only — never execute a repo-local ci-select.ts (RAD-167-R3).
 */
export async function resolveCiSelection(
  options: ResolveCiSelectionOptions,
): Promise<ResolveCiSelectionResult> {
  const paths = options.changedPaths;
  const worktreePath = options.worktreePath?.trim() ? path.resolve(options.worktreePath) : null;
  const selectOpts = worktreePath
    ? { cwd: worktreePath }
    : options.primaryPath?.trim()
      ? { cwd: path.resolve(options.primaryPath) }
      : undefined;
  const installedSelect = options.installedSelect ?? selectCiChecks;
  const installed = installedSelect(paths, selectOpts);
  const touches = touchesCiSelectionSource(paths);
  const refuseOnTouch = options.refuseStaleOnTouch !== false;
  const installedLooksStale = looksLikeStaleFullSuitePlan(installed);

  if (!worktreePath) {
    if (installedLooksStale) {
      throw new Error(
        `Refusing stale installed CI selection: no worktree. ` +
          `Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)} reason=${JSON.stringify(installed.reason)}`,
      );
    }
    return { selection: installed, source: "installed", diverged: false };
  }

  if (!isPrGenieRepo(worktreePath)) {
    if (installedLooksStale) {
      throw new Error(
        `Refusing stale installed CI selection: host repo (not prgenie). ` +
          `Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)}`,
      );
    }
    return { selection: installed, source: "installed", diverged: false };
  }

  const gitRoot = (await findGitRoot(worktreePath)) ?? worktreePath;
  const baseRef = options.baseRef?.trim() || "main";
  const injectedBaseLoader = options.loadBaseRefSelect != null;
  const resolvedBase = await resolveCiGateBaseRef(gitRoot, baseRef);
  if (!injectedBaseLoader && !resolvedBase) {
    const short = ciGateBaseShortName(baseRef);
    const tried = [baseRef, `origin/${short}`, `refs/remotes/origin/${short}`];
    warnLoud(formatCiGateBaseRefResolutionFailure(baseRef, tried));
  }
  const baseLoader =
    options.loadBaseRefSelect ??
    ((root: string, ref: string, primary?: string | null) =>
      loadBaseRefSelectCiChecks(root, ref, primary));
  const baseSelectFn =
    injectedBaseLoader || resolvedBase
      ? await baseLoader(gitRoot, baseRef, options.primaryPath)
      : null;
  const baseCacheKey = resolvedBase ? baseSelectCacheKey(gitRoot, resolvedBase.sha) : null;

  let gatePlan: CiCheckSelection;
  let gateSource: "base" | "installed";
  if (baseSelectFn) {
    try {
      gatePlan = baseSelectFn(paths, selectOpts);
      gateSource = "base";
    } catch (err) {
      if (baseCacheKey) dropBaseSelectCacheEntry(baseCacheKey);
      throw err;
    }
    // RAD-167-R1: the plan is plain data. CLI fallback already read ci-select.ts
    // during baseSelectFn, so the detached checkout is no longer needed.
    if (baseCacheKey) dropBaseSelectCacheEntry(baseCacheKey);
  } else {
    gatePlan = installed;
    gateSource = "installed";
  }

  const loader =
    options.loadWorktreeSelect ??
    ((wt: string) => loadWorktreeSelectCiChecks(wt, { primaryPath: options.primaryPath }));

  let advisorySelection: CiCheckSelection | undefined;
  if (existsSync(worktreeCiSelectModulePath(worktreePath))) {
    try {
      const worktreeSelect = await loader(worktreePath);
      if (worktreeSelect) {
        advisorySelection = worktreeSelect(paths, selectOpts);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnLoud(`RAD-167-R2: advisory worktree ci-select load failed (${detail})`);
    }
  }

  const diverged = advisorySelection ? !ciSelectionPlansEqual(gatePlan, advisorySelection) : false;

  if (!injectedBaseLoader) {
    if (!resolvedBase) {
      const short = ciGateBaseShortName(baseRef);
      const tried = [baseRef, `origin/${short}`, `refs/remotes/origin/${short}`];
      throw new Error(formatCiGateBaseRefResolutionFailure(baseRef, tried));
    }
    if (!baseSelectFn) {
      throw new Error(
        `Refusing stale installed CI selection: could not load base-commit ci-select from ${gitRoot}@${baseRef}. ` +
          `Export/run_ci must evaluate selectCiChecks from the loop base (RAD-167-R1).` +
          (installedLooksStale
            ? ` Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)}`
            : ""),
      );
    }
  } else if (
    (touches && refuseOnTouch && !baseSelectFn) ||
    (installedLooksStale && !baseSelectFn)
  ) {
    throw new Error(
      `Refusing stale installed CI selection: could not load base-commit ci-select from ${gitRoot}@${baseRef}. ` +
        `Export/run_ci must evaluate selectCiChecks from the loop base (RAD-167-R1).` +
        (installedLooksStale
          ? ` Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)}`
          : ""),
    );
  }

  const gateSelection =
    gateSource === "base"
      ? withBaseGateProvenance(gatePlan, diverged, advisorySelection)
      : gatePlan;

  if (diverged && advisorySelection) {
    // RAD-167-R1: "base gate" only when base-commit ci-select actually loaded.
    const gateLabel = gateSource === "base" ? "base gate" : "installed gate";
    const installedProvenance =
      gateSource === "installed"
        ? "RAD-167-R1: base-commit ci-select did not load; export gate uses the installed plugin. "
        : "";
    const warning =
      `CI selection DIVERGED (RAD-167-R2): ${gateLabel} vs loop worktree (advisory). ` +
      installedProvenance +
      `gate={checks:${JSON.stringify(gatePlan.checks)},reason:${JSON.stringify(gatePlan.reason)}} ` +
      `worktree={checks:${JSON.stringify(advisorySelection.checks)},reason:${JSON.stringify(advisorySelection.reason)}}`;
    warnLoud(warning);
    return {
      selection: gateSelection,
      source: gateSource,
      diverged: true,
      warning,
      advisorySelection,
    };
  }

  return {
    selection: gateSelection,
    source: gateSource,
    diverged: false,
    advisorySelection,
  };
}

/** Read worktree module text (tests / diagnostics). */
export async function readWorktreeCiSelectSource(worktreePath: string): Promise<string | null> {
  const modulePath = worktreeCiSelectModulePath(worktreePath);
  if (!existsSync(modulePath)) return null;
  return readFile(modulePath, "utf8");
}
