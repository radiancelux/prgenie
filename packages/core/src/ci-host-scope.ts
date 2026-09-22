import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyCiPath,
  normalizeCiPath,
  packageFromScopedCheck,
} from "./ci-select.js";
import { ciCheckCommand } from "./progress.js";

/** Extensions eslint (and similar JS linters) can take as path args. */
const ESLINT_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
]);

export type HostScopeTool = "eslint" | "prettier" | "turbo" | "pnpm-recursive";

export interface MonorepoWideScript {
  tool: HostScopeTool;
  /** Original package.json script body. */
  script: string;
  /** Tokens after the tool binary (flags + original path tokens). */
  args: string[];
}

export interface ResolvedCiCommand {
  /** Shell command that will actually run (shown on the progress card). */
  command: string;
  /** True when a monorepo-wide root script was rewritten to path/package filters. */
  hostScoped: boolean;
  /** Why we scoped or kept the full script. */
  reason?: string;
}

export interface ResolveCiCheckCommandOptions {
  check: string;
  cwd: string;
  /** Loop diff + dirty tree paths. */
  changedPaths?: string[];
  /**
   * When true, never rewrite monorepo-wide scripts (config / unknown / empty).
   * Prefer {@link hostScopeFailClosedReason} when calling from the runner.
   */
  failClosed?: boolean;
  failClosedReason?: string;
  /** Optional pre-read scripts map (tests). */
  scripts?: Record<string, string> | null;
}

/** Read root package.json scripts, or null when missing/invalid. */
export function readPackageScripts(cwd: string): Record<string, string> | null {
  try {
    const raw = readFileSync(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (!pkg.scripts || typeof pkg.scripts !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Fail-closed gate for host-repo path scoping.
 * Config or unknown paths always keep the full script; empty paths too.
 */
export function hostScopeFailClosedReason(changedPaths: string[] | undefined): string | null {
  if (changedPaths == null || changedPaths.length === 0) {
    return "no changed paths → full script";
  }
  for (const file of changedPaths) {
    const kind = classifyCiPath(file);
    if (kind === "config") return "config/CI changed → full script";
    if (kind === "unknown") return "uncertain path mapping → full script";
  }
  return null;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function joinCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

/** Simple whitespace tokenizer (keeps quoted segments). */
export function tokenizeScript(script: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    let tok = m[0];
    if (
      (tok.startsWith('"') && tok.endsWith('"')) ||
      (tok.startsWith("'") && tok.endsWith("'"))
    ) {
      tok = tok.slice(1, -1);
    }
    tokens.push(tok);
  }
  return tokens;
}

function isDotPathToken(tok: string): boolean {
  return tok === "." || tok === "./" || tok === ".\\" || tok === "./.";
}

/** True when a token is a file/dir path (not a flag value like `0` or `.ts,.tsx`). */
function looksLikePathToken(tok: string): boolean {
  if (isDotPathToken(tok)) return true;
  if (tok.startsWith("-")) return false;
  if (tok.includes("/") || tok.includes("\\")) return true;
  const ext = path.posix.extname(tok).toLowerCase();
  // `file.ts` yes; `.ts,.tsx` (ext flag value) no.
  if (ESLINT_EXTS.has(ext) && !tok.startsWith(".")) return true;
  return false;
}

/**
 * Detect monorepo-wide root scripts (Phoenix-style `eslint .`, turbo without filter, etc.).
 * Already path-scoped scripts (prgenie `eslint packages/core/src …`) return null.
 */
export function detectMonorepoWideScript(script: string): MonorepoWideScript | null {
  const trimmed = script.trim();
  if (!trimmed) return null;
  const tokens = tokenizeScript(trimmed);
  if (tokens.length === 0) return null;

  // Strip pnpm/npm/npx/yarn exec wrappers to find the real binary.
  let i = 0;
  if (
    (tokens[0] === "pnpm" || tokens[0] === "npm" || tokens[0] === "yarn") &&
    tokens[1] === "exec"
  ) {
    i = 2;
  } else if (tokens[0] === "npx" || tokens[0] === "pnpx") {
    i = 1;
  }

  const bin = tokens[i];
  if (!bin) return null;
  const rest = tokens.slice(i + 1);

  // pnpm -r / recursive / -r --filter=* style (whole workspace).
  if (tokens[0] === "pnpm" || tokens[0] === "yarn") {
    const recursive =
      tokens.includes("-r") ||
      tokens.includes("--recursive") ||
      tokens.includes("recursive") ||
      tokens.includes("-w") ||
      tokens.includes("--workspace-concurrency");
    const hasFilter = tokens.some((t) => t === "--filter" || t.startsWith("--filter="));
    if (recursive && !hasFilter) {
      return { tool: "pnpm-recursive", script: trimmed, args: tokens.slice(1) };
    }
  }

  if (bin === "turbo" || bin === "turbo.exe") {
    const hasFilter = rest.some((t) => t === "--filter" || t.startsWith("--filter="));
    if (!hasFilter) {
      return { tool: "turbo", script: trimmed, args: rest };
    }
    return null;
  }

  if (bin === "eslint" || bin === "eslint.cmd") {
    const pathToks = rest.filter(looksLikePathToken);
    if (pathToks.length === 0 || pathToks.every(isDotPathToken)) {
      return { tool: "eslint", script: trimmed, args: rest };
    }
    // Explicit package/dir targets already scoped (RAD-105 prgenie root lint).
    return null;
  }

  if (bin === "prettier" || bin === "prettier.cmd") {
    const pathToks = rest.filter(looksLikePathToken);
    if (pathToks.length === 0 || pathToks.every(isDotPathToken)) {
      return { tool: "prettier", script: trimmed, args: rest };
    }
    return null;
  }

  return null;
}

/** Lintable source/test paths for eslint path args. */
export function eslintPathsFromChanged(changedPaths: string[]): string[] {
  const out: string[] = [];
  for (const file of changedPaths) {
    const p = normalizeCiPath(file);
    const kind = classifyCiPath(p);
    if (kind !== "source" && kind !== "test") continue;
    const ext = path.posix.extname(p).toLowerCase();
    if (!ESLINT_EXTS.has(ext)) continue;
    out.push(p);
  }
  return [...new Set(out)];
}

/** Package directory filters (`./packages/foo`) from changed paths. */
export function packageFiltersFromChanged(changedPaths: string[]): string[] {
  const filters = new Set<string>();
  for (const file of changedPaths) {
    const p = normalizeCiPath(file);
    const m = p.match(/^(packages|apps|services)\/([^/]+)\//);
    if (m) filters.add(`./${m[1]}/${m[2]}`);
  }
  return [...filters];
}

function flagsOnly(args: string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (isDotPathToken(t)) continue;
    if (!t.startsWith("-")) continue;
    flags.push(t);
    // Keep values for --ext .ts etc. when next token is not a flag/path-dot.
    const next = args[i + 1];
    if (next && !next.startsWith("-") && !isDotPathToken(next) && !ESLINT_EXTS.has(path.posix.extname(next))) {
      // --ext .ts,.tsx — value starts with .
      if (next.startsWith(".") && next !== "." && next !== "./") {
        flags.push(next);
        i++;
      } else if (!/\//.test(next) && !ESLINT_EXTS.has(path.posix.extname(next))) {
        flags.push(next);
        i++;
      }
    }
  }
  return flags;
}

function prettierFlagsOnly(args: string[]): string[] {
  return args.filter((t) => t.startsWith("-") || t.startsWith("--"));
}

/**
 * Map a smart-CI check name to the shell command that will run.
 * Package-scoped names stay on {@link ciCheckCommand}.
 * Host-repo monorepo-wide scripts (`eslint .`, turbo without filter) prefer
 * changed-path / package-filter args when safe; otherwise fail closed to `pnpm <check>`.
 */
export function resolveCiCheckCommand(options: ResolveCiCheckCommandOptions): ResolvedCiCommand {
  const { check, cwd } = options;
  const fallback = ciCheckCommand(check);

  // RAD-105 package scopes — never rewrite.
  if (packageFromScopedCheck(check)) {
    return { command: fallback, hostScoped: false };
  }

  const closed =
    options.failClosedReason ??
    (options.failClosed ? "fail-closed → full script" : hostScopeFailClosedReason(options.changedPaths));
  if (closed) {
    return { command: fallback, hostScoped: false, reason: closed };
  }

  const scripts = options.scripts === undefined ? readPackageScripts(cwd) : options.scripts;
  const script = scripts?.[check];
  if (!script) {
    return { command: fallback, hostScoped: false, reason: "no package.json script → pnpm check" };
  }

  const wide = detectMonorepoWideScript(script);
  if (!wide) {
    // Already path-scoped or unrecognized — keep `pnpm <check>` (prgenie root lint, etc.).
    return {
      command: fallback,
      hostScoped: false,
      reason: "script not monorepo-wide → pnpm check",
    };
  }

  const paths = (options.changedPaths ?? []).map(normalizeCiPath);

  if (wide.tool === "eslint") {
    const lintPaths = eslintPathsFromChanged(paths);
    if (lintPaths.length === 0) {
      return {
        command: fallback,
        hostScoped: false,
        reason: "no eslint-able changed paths → full script",
      };
    }
    const flags = flagsOnly(wide.args);
    const command = joinCommand(["pnpm", "exec", "eslint", ...flags, ...lintPaths]);
    return {
      command,
      hostScoped: true,
      reason: `host-repo eslint scoped to ${lintPaths.length} changed path(s)`,
    };
  }

  if (wide.tool === "prettier") {
    const prettyPaths = paths.filter((p) => {
      const kind = classifyCiPath(p);
      return kind === "source" || kind === "test" || kind === "docs" || kind === "style";
    });
    if (prettyPaths.length === 0) {
      return {
        command: fallback,
        hostScoped: false,
        reason: "no prettier-able changed paths → full script",
      };
    }
    const flags = prettierFlagsOnly(wide.args);
    // Preserve --check / --write from the script when present.
    const hasMode = flags.some((f) => f === "--check" || f === "--write" || f === "-c" || f === "-w");
    const mode: string[] = hasMode ? [] : ["--check"];
    const command = joinCommand(["pnpm", "exec", "prettier", ...flags, ...mode, ...prettyPaths]);
    return {
      command,
      hostScoped: true,
      reason: `host-repo prettier scoped to ${prettyPaths.length} changed path(s)`,
    };
  }

  if (wide.tool === "turbo") {
    const filters = packageFiltersFromChanged(paths);
    if (filters.length === 0) {
      return {
        command: fallback,
        hostScoped: false,
        reason: "no package dirs for turbo --filter → full script",
      };
    }
    const filterArgs = filters.flatMap((f) => ["--filter", f]);
    const command = joinCommand(["pnpm", "exec", "turbo", ...wide.args, ...filterArgs]);
    return {
      command,
      hostScoped: true,
      reason: `host-repo turbo filtered to ${filters.join(", ")}`,
    };
  }

  if (wide.tool === "pnpm-recursive") {
    const filters = packageFiltersFromChanged(paths);
    if (filters.length === 0) {
      return {
        command: fallback,
        hostScoped: false,
        reason: "no package dirs for pnpm --filter → full script",
      };
    }
    // Rewrite `pnpm -r lint` → `pnpm --filter ./apps/foo --filter ./apps/bar lint`
    const scriptTokens = tokenizeScript(wide.script);
    const withoutRecursive = scriptTokens.filter(
      (t) => t !== "-r" && t !== "--recursive" && t !== "recursive",
    );
    // withoutRecursive starts with pnpm
    const rest = withoutRecursive[0] === "pnpm" || withoutRecursive[0] === "yarn"
      ? withoutRecursive.slice(1)
      : withoutRecursive;
    const filterArgs = filters.flatMap((f) => ["--filter", f]);
    const command = joinCommand(["pnpm", ...filterArgs, ...rest]);
    return {
      command,
      hostScoped: true,
      reason: `host-repo pnpm filtered to ${filters.join(", ")}`,
    };
  }

  return { command: fallback, hostScoped: false, reason: "unrecognized host script → full script" };
}
