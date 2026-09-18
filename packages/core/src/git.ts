import { spawn } from "node:child_process";
import path from "node:path";

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
    const child = spawn("git", args, {
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
    child.on("error", reject);
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
