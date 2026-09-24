import { createRequire } from "node:module";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
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
  /** Where the winning plan came from. */
  source: "installed" | "worktree";
  /** True when installed and worktree plans disagreed on checks, reasons, or flags. */
  diverged: boolean;
  /** Loud dogfood warning when plans diverge (also mirrored on stderr). */
  warning?: string;
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
};

type CacheEntry = { mtimeMs: number; select: CiSelectFn };
const worktreeSelectCache = new Map<string, CacheEntry>();

/** Test helper — clear the worktree selector cache. */
export function clearWorktreeCiSelectCache(): void {
  worktreeSelectCache.clear();
}

function warnLoud(message: string): void {
  try {
    process.stderr.write(`[prgenie] ${message}\n`);
  } catch {
    // ignore
  }
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

  let tsImportFn = options.tsImport;
  if (!tsImportFn) {
    const api = await loadTsxApi(worktreePath, options.primaryPath);
    if (api) tsImportFn = api.tsImport;
  }

  if (tsImportFn) {
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

function withWorktreeProvenance(selection: CiCheckSelection, diverged: boolean): CiCheckSelection {
  const stamp = diverged
    ? "RAD-123: using worktree ci-select (installed plugin diverged)"
    : "RAD-123: using worktree ci-select";
  const reason = selection.reason.includes(stamp) ? selection.reason : [stamp, ...selection.reason];
  return { ...selection, reason };
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
      /fixture|RAD-123|worktree ci-select|per-package|confident mapping|skip local CI|caller-forced/i.test(
        r,
      ),
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve the CI plan for a loop: always evaluate `selectCiChecks` from the
 * loop worktree source when that module loads (RAD-123). Installed-plugin plans
 * are compared for dogfood; divergence is warned loudly and refused (worktree wins).
 * Never fall back to a stale root `pnpm test` / full-suite installed plan.
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

  if (!worktreePath || !existsSync(worktreeCiSelectModulePath(worktreePath))) {
    if ((touches && refuseOnTouch) || installedLooksStale) {
      throw new Error(
        `Refusing stale installed CI selection: worktree ci-select module missing ` +
          `(${worktreePath ?? "no worktree"}). ` +
          `Export/run_ci must evaluate selectCiChecks from the loop worktree source (RAD-123).` +
          (installedLooksStale
            ? ` Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)} reason=${JSON.stringify(installed.reason)}`
            : ""),
      );
    }
    return { selection: installed, source: "installed", diverged: false };
  }

  const loader =
    options.loadWorktreeSelect ??
    ((wt: string) => loadWorktreeSelectCiChecks(wt, { primaryPath: options.primaryPath }));

  let worktreeSelect: CiSelectFn | null;
  try {
    worktreeSelect = await loader(worktreePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if ((touches && refuseOnTouch) || installedLooksStale) {
      throw new Error(
        `Refusing stale installed CI selection: failed to load worktree ci-select from ${worktreePath}: ${detail}` +
          (installedLooksStale
            ? ` Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)}`
            : ""),
        { cause: err },
      );
    }
    warnLoud(`RAD-123: worktree ci-select load failed (${detail}); using installed plugin plan`);
    return {
      selection: installed,
      source: "installed",
      diverged: false,
      warning: `worktree ci-select load failed: ${detail}`,
    };
  }

  if (!worktreeSelect) {
    if ((touches && refuseOnTouch) || installedLooksStale) {
      throw new Error(
        `Refusing stale installed CI selection: could not load worktree selectCiChecks from ${worktreePath} ` +
          `(tsx unavailable?). Gate must use worktree source — never root pnpm test (RAD-123).` +
          (installedLooksStale
            ? ` Installed plan looks like a full suite: checks=${JSON.stringify(installed.checks)} reason=${JSON.stringify(installed.reason)}`
            : ""),
      );
    }
    return { selection: installed, source: "installed", diverged: false };
  }

  const worktreePlan = worktreeSelect(paths, selectOpts);
  const diverged = !ciSelectionPlansEqual(installed, worktreePlan);

  if (diverged) {
    const warning =
      `CI selection DIVERGED: installed plugin vs worktree. Using worktree (refusing stale installed plan). ` +
      `installed={checks:${JSON.stringify(installed.checks)},reason:${JSON.stringify(installed.reason)}} ` +
      `worktree={checks:${JSON.stringify(worktreePlan.checks)},reason:${JSON.stringify(worktreePlan.reason)}}`;
    warnLoud(`RAD-123: ${warning}`);
    return {
      selection: withWorktreeProvenance(worktreePlan, true),
      source: "worktree",
      diverged: true,
      warning,
    };
  }

  // Worktree module loaded — always gate with it (even when plans match) so a
  // loop cannot silently run an older in-memory selector after a future edit.
  return {
    selection: withWorktreeProvenance(worktreePlan, false),
    source: "worktree",
    diverged: false,
  };
}

/** Read worktree module text (tests / diagnostics). */
export async function readWorktreeCiSelectSource(worktreePath: string): Promise<string | null> {
  const modulePath = worktreeCiSelectModulePath(worktreePath);
  if (!existsSync(modulePath)) return null;
  return readFile(modulePath, "utf8");
}
