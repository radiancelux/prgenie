import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Absolute path to git.exe / git. Overrides PATH and well-known install locations. */
export const PRGENIE_GIT_ENV = "PRGENIE_GIT";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export class GitBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitBinaryError";
  }
}

export type ResolveGitBinaryOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  existsSync?: (filePath: string) => boolean;
  /** Skip the process-wide cache (tests / one-off probes). */
  bypassCache?: boolean;
};

let cachedGitBinary: string | null | undefined;

export function clearGitBinaryCache(): void {
  cachedGitBinary = undefined;
}

export function formatGitMissingError(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return (
      `git is not resolvable from this process. Install Git for Windows ` +
      `(https://git-scm.com/download/win) and ensure git.exe is on PATH, ` +
      `or set ${PRGENIE_GIT_ENV} to the absolute path of git.exe ` +
      `(e.g. C:\\Program Files\\Git\\cmd\\git.exe).`
    );
  }
  return (
    `git is not resolvable from this process. Install git and ensure it is on PATH, ` +
    `or set ${PRGENIE_GIT_ENV} to the absolute path of the git binary.`
  );
}

/** Clear MCP/CLI error when `spawn(git)` fails (ENOENT / bad path / EACCES). */
export function formatGitSpawnError(
  binary: string,
  err: NodeJS.ErrnoException,
  platform: NodeJS.Platform = process.platform,
): string {
  const detail = err.code ? `${err.code}: ${err.message}` : err.message;
  if (err.code === "ENOENT") {
    return formatGitMissingError(platform);
  }
  return `Failed to spawn git at "${binary}" (${detail}). ` + formatGitMissingError(platform);
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function findOnPath(
  names: string[],
  pathEnv: string,
  exists: (filePath: string) => boolean,
  delimiter: string,
): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Well-known Git for Windows install layouts (Program Files + LocalAppData). */
export function windowsGitCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA?.trim();
  const out = [
    path.join(pf, "Git", "cmd", "git.exe"),
    path.join(pf, "Git", "bin", "git.exe"),
    path.join(pf86, "Git", "cmd", "git.exe"),
    path.join(pf86, "Git", "bin", "git.exe"),
  ];
  if (local) {
    out.push(path.join(local, "Programs", "Git", "cmd", "git.exe"));
    out.push(path.join(local, "Programs", "Git", "bin", "git.exe"));
  }
  return out;
}

/**
 * Resolve an absolute git binary path.
 *
 * Order: `PRGENIE_GIT` → PATH (`where`/`which` style walk) → Windows well-known locations.
 */
export function resolveGitBinary(options: ResolveGitBinaryOptions = {}): string | null {
  const useCache =
    !options.bypassCache &&
    options.env === undefined &&
    options.pathEnv === undefined &&
    options.existsSync === undefined &&
    options.platform === undefined;

  if (useCache && cachedGitBinary !== undefined) {
    return cachedGitBinary;
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? existsSync;
  const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
  const delimiter = pathDelimiter(platform);

  const override = env[PRGENIE_GIT_ENV]?.trim();
  if (override) {
    const resolved = exists(override) ? override : null;
    if (useCache) cachedGitBinary = resolved;
    return resolved;
  }

  const names = platform === "win32" ? ["git.exe", "git"] : ["git"];
  const onPath = findOnPath(names, pathEnv, exists, delimiter);
  if (onPath) {
    if (useCache) cachedGitBinary = onPath;
    return onPath;
  }

  if (platform === "win32") {
    for (const candidate of windowsGitCandidates(env)) {
      if (exists(candidate)) {
        if (useCache) cachedGitBinary = candidate;
        return candidate;
      }
    }
  }

  if (useCache) cachedGitBinary = null;
  return null;
}

export function requireGitBinary(options?: ResolveGitBinaryOptions): string {
  const resolved = resolveGitBinary(options);
  if (resolved) return resolved;

  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const override = env[PRGENIE_GIT_ENV]?.trim();
  if (override) {
    throw new GitBinaryError(
      `${PRGENIE_GIT_ENV} is set to "${override}" but that path does not exist. ` +
        formatGitMissingError(platform),
    );
  }
  throw new GitBinaryError(formatGitMissingError(platform));
}

export async function git(
  cwd: string,
  args: string[],
  options: { stdin?: string; allowFail?: boolean; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }

    let binary: string;
    try {
      binary = requireGitBinary();
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(binary, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearGitBinaryCache();
      // Spawn failures (missing binary, bad path, EACCES, …) share one actionable message.
      reject(new GitBinaryError(formatGitSpawnError(binary, err)));
    });
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        const err = new Error("Cancelled");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const result = {
        stdout: stdout.replace(/\r\n/g, "\n"),
        stderr: stderr.replace(/\r\n/g, "\n"),
        code: code ?? 1,
      };
      if (result.code !== 0 && !options.allowFail) {
        reject(new GitError(args, result.stderr, result.code));
        return;
      }
      resolve(result);
    });
  });
}

export async function gitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"], {
    allowFail: true,
  });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const dir = await gitText(cwd, ["rev-parse", "--git-common-dir"]);
  return path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(cwd, dir);
}

export async function requireGitRoot(cwd: string): Promise<string> {
  const root = await findGitRoot(cwd);
  if (!root) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  return root;
}
