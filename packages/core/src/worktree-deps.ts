import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  listWorktrees,
  loopWorktreeIdentity,
  primaryWorktreePath,
  sameFsPath,
} from "./worktrees.js";

const execAsync = promisify(exec);

/** Bins CI must resolve from the worktree (pnpm exec / .bin). turbo/vitest optional. */
export const REQUIRED_CI_BINS = ["eslint", "tsc", "tsx", "prettier"] as const;
export const OPTIONAL_CI_BINS = ["turbo", "vitest"] as const;

/** Tool names that may appear in spawn / MODULE_NOT_FOUND env failures. */
const CI_ENV_TOOL_NAMES = [...REQUIRED_CI_BINS, ...OPTIONAL_CI_BINS, "typescript"] as const;
const CI_ENV_TOOL_ALT = CI_ENV_TOOL_NAMES.join("|");

export type ToolchainLinkMethod = "junction" | "symlink" | "present" | "install" | "none";

export interface ToolchainEnsureResult {
  ok: boolean;
  /** True when missing bins / link failure — not a product lint/test fail. */
  envUnhealthy: boolean;
  worktreePath: string;
  primaryPath: string | null;
  method: ToolchainLinkMethod;
  linked: string[];
  message: string;
  fixSteps: string[];
}

export interface EnsureToolchainOptions {
  /** Override primary checkout (tests). */
  primaryPath?: string | null;
  /** Attempt `pnpm install` in the worktree when junction/link is impossible. Default true. */
  allowInstall?: boolean;
  /** Extra required bin names (beyond REQUIRED_CI_BINS). */
  requiredBins?: string[];
  /** Skip install even when allowInstall would run (unit tests). */
  skipInstall?: boolean;
}

function binStubs(modulesRoot: string, name: string): string[] {
  const binDir = path.join(modulesRoot, ".bin");
  if (process.platform === "win32") {
    return [
      path.join(binDir, `${name}.CMD`),
      path.join(binDir, `${name}.cmd`),
      path.join(binDir, `${name}.ps1`),
      path.join(binDir, name),
      path.join(binDir, `${name}.exe`),
    ];
  }
  return [path.join(binDir, name)];
}

/** True when `name` is resolvable via node_modules/.bin under `cwd`. */
export function hasCiBin(cwd: string, name: string): boolean {
  const modules = path.join(cwd, "node_modules");
  if (!existsSync(modules)) return false;
  return binStubs(modules, name).some((p) => existsSync(p));
}

export function missingCiBins(
  cwd: string,
  required: readonly string[] = REQUIRED_CI_BINS,
): string[] {
  return required.filter((name) => !hasCiBin(cwd, name));
}

/**
 * Detect opaque "tool not found" failures vs real product CI fails.
 * Used so shepherd can soft-surface env unhealthy without hard-blocking export.
 *
 * Only the first non-empty line (spawn / shell failure) is probed — never the full
 * log — so product fixtures that mention "command not found" stay product fails.
 * Matches must name a known CI tool (eslint/tsc/tsx/prettier/…).
 */
export function isCiEnvFailureOutput(text: string): boolean {
  const t = text.replace(/\r\n/g, "\n");
  if (/Missing toolchain in worktree/i.test(t) || /CI environment unhealthy/i.test(t)) {
    return true;
  }

  const firstLine =
    t
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  // Cap so buried product logs never get scanned even if callers pass combined output.
  const probe = firstLine.slice(0, 480);
  if (!probe) return false;

  const tool = CI_ENV_TOOL_ALT;
  return (
    new RegExp(
      `['"]?(?:${tool})['"]?(?:\\.cmd|\\.CMD|\\.exe)?\\s+is not recognized as an internal or external command`,
      "i",
    ).test(probe) ||
    new RegExp(
      `(?:^|[\\s\`'"])(?:${tool})(?:\\.cmd|\\.CMD|\\.exe)?\\s*:\\s*command not found`,
      "i",
    ).test(probe) ||
    new RegExp(`Command ["'](?:${tool})["'] not found`, "i").test(probe) ||
    (/ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/i.test(probe) && new RegExp(tool, "i").test(probe)) ||
    new RegExp(`Cannot find module ['"](?:${tool})`, "i").test(probe) ||
    (/MODULE_NOT_FOUND/i.test(probe) && new RegExp(tool, "i").test(probe))
  );
}

export function formatToolchainFixSteps(input: {
  worktreePath: string;
  primaryPath: string | null;
  missing?: string[];
}): string[] {
  const steps: string[] = [];
  const primary = input.primaryPath;
  if (primary) {
    steps.push(
      `From the primary checkout (${primary}): ensure deps exist — \`pnpm install\` (once, not per loop).`,
    );
    steps.push(
      `Then re-run CI; PR Genie junctions \`node_modules\` into the loop worktree (${input.worktreePath}) on Windows (symlink elsewhere).`,
    );
  } else {
    steps.push(`From a full checkout of this repo: \`pnpm install\`, then re-run CI.`);
  }
  steps.push(
    `If a junction/link is impossible (permissions / cross-device): \`cd "${input.worktreePath}" && pnpm install\`.`,
  );
  if (input.missing?.length) {
    steps.push(`Still missing after link/install: ${input.missing.join(", ")}.`);
  }
  return steps;
}

async function resolvePrimaryForWorktree(
  worktreePath: string,
  override?: string | null,
): Promise<string | null> {
  if (override) return path.resolve(override);
  const ident = loopWorktreeIdentity(worktreePath);
  if (ident?.primaryPath && existsSync(ident.primaryPath)) return ident.primaryPath;
  try {
    const trees = await listWorktrees(worktreePath);
    const primary = primaryWorktreePath(trees);
    if (primary && !sameFsPath(primary, worktreePath)) return primary;
  } catch {
    // Not a git worktree listing — fall through.
  }
  return null;
}

/** True when path exists as a real directory (not only a dangling name). */
function isExistingDir(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

async function linkDirectory(targetLink: string, sourceDir: string): Promise<ToolchainLinkMethod> {
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(sourceDir, targetLink, type);
  return process.platform === "win32" ? "junction" : "symlink";
}

function resolvePathCanon(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    try {
      return path.resolve(absPath);
    } catch {
      return null;
    }
  }
}

/**
 * True when every `@prgenie/<pkg>` under `packages/<packageName>/node_modules`
 * resolves into the worktree's `packages/<pkg>` (not the primary tree).
 * Packages without an `@prgenie` scope (and primary without one) are ok.
 */
export function packagePrgenieLinksPointAtWorktree(
  worktreeDir: string,
  packageName: string,
  primaryDir?: string,
): { ok: boolean; detail?: string } {
  const scope = path.join(worktreeDir, "packages", packageName, "node_modules", "@prgenie");
  const primaryScope = primaryDir
    ? path.join(primaryDir, "packages", packageName, "node_modules", "@prgenie")
    : null;
  if (!isExistingDir(scope)) {
    // Dest missing @prgenie while primary has one → incomplete mirror.
    if (primaryScope && isExistingDir(primaryScope)) {
      return {
        ok: false,
        detail: `packages/${packageName}/node_modules is missing @prgenie (incomplete mirror)`,
      };
    }
    return { ok: true };
  }
  for (const ws of readdirSync(scope)) {
    const expected = path.join(worktreeDir, "packages", ws);
    if (!isExistingDir(expected)) {
      return {
        ok: false,
        detail: `packages/${packageName}/node_modules/@prgenie/${ws} present but worktree lacks packages/${ws}`,
      };
    }
    const resolved = resolvePathCanon(path.join(scope, ws));
    const expectedCanon = resolvePathCanon(expected);
    if (!resolved || !expectedCanon || !sameFsPath(resolved, expectedCanon)) {
      return {
        ok: false,
        detail: `packages/${packageName}/node_modules/@prgenie/${ws} does not resolve to worktree packages/${ws}`,
      };
    }
  }
  return { ok: true };
}

async function ensureOneNodeModulesLink(
  worktreeDir: string,
  primaryDir: string,
  relativeModules = "node_modules",
): Promise<{ linked: boolean; method: ToolchainLinkMethod; path: string }> {
  const dest = path.join(worktreeDir, relativeModules);
  const source = path.join(primaryDir, relativeModules);
  if (!isExistingDir(source)) {
    return { linked: false, method: "none", path: dest };
  }
  if (isExistingDir(dest)) {
    // Already present (real install or prior junction) — leave it.
    return { linked: false, method: "present", path: dest };
  }
  // Broken leftover name?
  if (existsSync(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
  await linkDirectory(dest, source);
  return {
    linked: true,
    method: process.platform === "win32" ? "junction" : "symlink",
    path: dest,
  };
}

/**
 * Mirror a package-local node_modules into the worktree as a real directory.
 * Each entry is junctioned/symlinked from primary, except workspace packages
 * (`@prgenie/*` → worktree `packages/<name>`). Whole-dir junction is unsafe:
 * retargeting nested links would mutate the primary tree.
 *
 * Partial / wrong-tree dests are removed and rebuilt — never treated as `present`.
 */
async function mirrorPackageNodeModules(
  worktreeDir: string,
  primaryDir: string,
  packageName: string,
): Promise<{ linked: boolean; method: ToolchainLinkMethod; path: string }> {
  const rel = path.join("packages", packageName, "node_modules");
  const dest = path.join(worktreeDir, rel);
  const source = path.join(primaryDir, rel);
  if (!isExistingDir(source)) {
    return { linked: false, method: "none", path: dest };
  }

  if (isExistingDir(dest)) {
    const check = packagePrgenieLinksPointAtWorktree(worktreeDir, packageName, primaryDir);
    if (check.ok) {
      return { linked: false, method: "present", path: dest };
    }
    // Partial or primary-pinned @prgenie — tear down and remirror.
    await rm(dest, { recursive: true, force: true });
  } else if (existsSync(dest)) {
    await rm(dest, { recursive: true, force: true });
  }

  const method: ToolchainLinkMethod = process.platform === "win32" ? "junction" : "symlink";
  try {
    await mkdir(dest, { recursive: true });
    for (const entry of readdirSync(source)) {
      const from = path.join(source, entry);
      const to = path.join(dest, entry);
      if (entry === "@prgenie") {
        await mkdir(to, { recursive: true });
        const scopeSrc = path.join(source, entry);
        if (!isExistingDir(scopeSrc)) continue;
        for (const ws of readdirSync(scopeSrc)) {
          const wsTarget = path.join(worktreeDir, "packages", ws);
          const wsLink = path.join(to, ws);
          if (!isExistingDir(wsTarget)) {
            throw new Error(
              `Cannot retarget @prgenie/${ws} for packages/${packageName}: worktree is missing packages/${ws}`,
            );
          }
          await linkDirectory(wsLink, wsTarget);
        }
        continue;
      }
      await linkDirectory(to, from);
    }
    const verify = packagePrgenieLinksPointAtWorktree(worktreeDir, packageName, primaryDir);
    if (!verify.ok) {
      throw new Error(
        verify.detail ?? `packages/${packageName}/node_modules @prgenie verify failed`,
      );
    }
    return { linked: true, method, path: dest };
  } catch (err) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function tryPnpmInstall(worktreePath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await execAsync("pnpm install", {
      cwd: worktreePath,
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: process.env.CI ?? "true" },
    });
    return { ok: true, detail: "pnpm install completed in worktree" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg.split("\n")[0] ?? msg };
  }
}

/**
 * Ensure the loop worktree can resolve CI bins (eslint/tsc/tsx/prettier).
 * Prefer junction/symlink of primary `node_modules`; install in-worktree only if link is impossible.
 */
export async function ensureWorktreeCiToolchain(
  worktreePath: string,
  options: EnsureToolchainOptions = {},
): Promise<ToolchainEnsureResult> {
  const cwd = path.resolve(worktreePath);
  const required = options.requiredBins?.length
    ? [...new Set([...REQUIRED_CI_BINS, ...options.requiredBins])]
    : [...REQUIRED_CI_BINS];
  const allowInstall = options.allowInstall !== false && options.skipInstall !== true;

  const alreadyMissing = missingCiBins(cwd, required);
  const primary = await resolvePrimaryForWorktree(cwd, options.primaryPath);
  const isLoopWorktree = Boolean(loopWorktreeIdentity(cwd)) || Boolean(options.primaryPath);

  // Non-loop checkouts (primary, unit fixtures): do not auto-junction or fail closed here.
  // Missing-bin product commands still classify as env unhealthy after the check runs.
  if (!isLoopWorktree) {
    if (alreadyMissing.length === 0) {
      return {
        ok: true,
        envUnhealthy: false,
        worktreePath: cwd,
        primaryPath: primary,
        method: "present",
        linked: [],
        message: "CI toolchain already resolvable in worktree.",
        fixSteps: [],
      };
    }
    return {
      ok: true,
      envUnhealthy: false,
      worktreePath: cwd,
      primaryPath: primary,
      method: "none",
      linked: [],
      message: "Not a loop worktree; skipped toolchain junction.",
      fixSteps: [],
    };
  }

  const linked: string[] = [];
  let method: ToolchainLinkMethod = alreadyMissing.length === 0 ? "present" : "none";
  let linkError: string | null = null;

  async function linkPackageModules(fromPrimary: string): Promise<void> {
    const packagesRoot = path.join(fromPrimary, "packages");
    if (!isExistingDir(packagesRoot)) return;
    const mirrorErrors: string[] = [];
    for (const name of readdirSync(packagesRoot)) {
      if (!isExistingDir(path.join(fromPrimary, "packages", name, "node_modules"))) continue;
      try {
        const pkgLink = await mirrorPackageNodeModules(cwd, fromPrimary, name);
        if (pkgLink.linked) {
          linked.push(path.join("packages", name, "node_modules").replace(/\\/g, "/"));
          if (method === "none" || method === "present") method = pkgLink.method;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        mirrorErrors.push(`${name}: ${detail}`);
      }
    }
    if (mirrorErrors.length > 0) {
      throw new Error(`Package node_modules mirror failed: ${mirrorErrors.join("; ")}`);
    }
  }

  if (primary && !sameFsPath(primary, cwd)) {
    const primaryModules = path.join(primary, "node_modules");
    if (!isExistingDir(primaryModules)) {
      if (alreadyMissing.length === 0) {
        // Bins somehow resolvable without primary modules — still try package links no-op.
        return {
          ok: true,
          envUnhealthy: false,
          worktreePath: cwd,
          primaryPath: primary,
          method: "present",
          linked: [],
          message: "CI toolchain already resolvable in worktree.",
          fixSteps: [],
        };
      }
      const fixSteps = formatToolchainFixSteps({
        worktreePath: cwd,
        primaryPath: primary,
        missing: alreadyMissing,
      });
      return {
        ok: false,
        envUnhealthy: true,
        worktreePath: cwd,
        primaryPath: primary,
        method: "none",
        linked: [],
        message:
          `Missing toolchain in worktree (and primary has no node_modules): ${alreadyMissing.join(", ")}. ` +
          `CI environment unhealthy — not a product test/lint failure.`,
        fixSteps,
      };
    }

    try {
      const root = await ensureOneNodeModulesLink(cwd, primary, "node_modules");
      if (root.linked) {
        linked.push("node_modules");
        method = root.method;
      } else if (root.method === "present" && method === "none") {
        method = "present";
      }
      await linkPackageModules(primary);
    } catch (err) {
      linkError = err instanceof Error ? err.message : String(err);
      method = "none";
    }
  }

  let afterMissing = missingCiBins(cwd, required);
  if (linkError) {
    const fixSteps = formatToolchainFixSteps({
      worktreePath: cwd,
      primaryPath: primary,
      missing: afterMissing.length ? afterMissing : undefined,
    });
    return {
      ok: false,
      envUnhealthy: true,
      worktreePath: cwd,
      primaryPath: primary,
      method,
      linked,
      message: `CI environment unhealthy — package/workspace toolchain mirror failed (not a product test/lint failure). ${linkError}`,
      fixSteps,
    };
  }
  if (afterMissing.length === 0) {
    return {
      ok: true,
      envUnhealthy: false,
      worktreePath: cwd,
      primaryPath: primary,
      method: linked.length ? method : "present",
      linked,
      message: linked.length
        ? `Linked CI toolchain from primary via ${method}: ${linked.join(", ")}.`
        : "CI toolchain resolvable after probing worktree.",
      fixSteps: [],
    };
  }

  // Junction/link impossible or insufficient — optional full install in the loop worktree.
  if (allowInstall && (linkError || !primary || afterMissing.length > 0)) {
    const installed = await tryPnpmInstall(cwd);
    if (installed.ok) {
      afterMissing = missingCiBins(cwd, required);
      if (afterMissing.length === 0) {
        return {
          ok: true,
          envUnhealthy: false,
          worktreePath: cwd,
          primaryPath: primary,
          method: "install",
          linked,
          message: `Installed CI toolchain in worktree (junction/link was insufficient${linkError ? `: ${linkError}` : ""}).`,
          fixSteps: [],
        };
      }
    } else if (!linkError) {
      linkError = installed.detail;
    }
  }

  const fixSteps = formatToolchainFixSteps({
    worktreePath: cwd,
    primaryPath: primary,
    missing: afterMissing,
  });
  const why = linkError
    ? `Link/install failed: ${linkError}`
    : primary
      ? `Still missing after link attempt: ${afterMissing.join(", ")}`
      : `Could not locate primary checkout to junction from; missing: ${afterMissing.join(", ")}`;

  return {
    ok: false,
    envUnhealthy: true,
    worktreePath: cwd,
    primaryPath: primary,
    method,
    linked,
    message:
      `Missing toolchain in worktree: ${afterMissing.join(", ")}. ` +
      `CI environment unhealthy — not a product test/lint failure. ${why}`,
    fixSteps,
  };
}

/** User-facing block for MCP/CLI when setup fails before checks run. */
export function formatToolchainSetupError(result: ToolchainEnsureResult): string {
  const steps = result.fixSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `${result.message}\nFix:\n${steps}`;
}
