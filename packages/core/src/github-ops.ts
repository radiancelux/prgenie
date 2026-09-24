import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findGitRoot } from "./git.js";
import { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";
import { parseGhAuthStatus, type GhAccount, type RepoGithubBind } from "./github.js";

/**
 * Quote one argv for cmd.exe when Node spawn({ shell: true }) joins args with spaces.
 * Without this, `gh pr create --title "RAD-95 — Foo bar"` splits on spaces (RAD-95 dogfood).
 *
 * Multiline payloads must **not** go through cmd.exe argv: even inside quotes, cmd truncates
 * at the first newline. Use `withGhBodyFile` + `gh --body-file` instead (RAD-129).
 * `%` is never safe-unquoted — cmd expands `%VAR%` in unquoted tokens.
 */
export function quoteWindowsShellArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/[\r\n]/.test(arg)) {
    throw new Error(
      "Refusing to pass a multiline argument through Windows cmd.exe argv (RAD-129). Use --body-file instead.",
    );
  }
  // Safe unquoted token — no whitespace, %, or cmd metacharacters.
  if (/^[A-Za-z0-9_./:\\@+=,:-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Apply Windows shell quoting when spawn will use shell:true. */
export function quoteGhArgsForSpawn(args: string[]): string[] {
  if (process.platform !== "win32") return args;
  return args.map(quoteWindowsShellArg);
}

/**
 * Write `body` to a temp file, invoke `fn(bodyFilePath)`, then delete the file
 * (success and failure). Prefer this over `gh --body` so newlines and `%VAR%`
 * never travel through Windows cmd.exe argv (RAD-129).
 */
export async function withGhBodyFile<T>(
  body: string,
  fn: (bodyFilePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "prgenie-gh-body-"));
  const bodyFilePath = path.join(dir, "body.md");
  await writeFile(bodyFilePath, body, "utf8");
  try {
    return await fn(bodyFilePath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `gh pr create` argv using `--body-file` (never `--body`). */
export function githubPrCreateArgs(options: {
  title: string;
  bodyFile: string;
  base: string;
  head: string;
}): string[] {
  return [
    "pr",
    "create",
    "--title",
    options.title,
    "--body-file",
    options.bodyFile,
    "--base",
    options.base,
    "--head",
    options.head,
  ];
}

function gh(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
    // On Windows, spawn without shell resolves gh.exe and skips gh.cmd shims
    // (PATH mocks in tests, and some install layouts). shell:true uses PATHEXT.
    // Quote args so titles/bodies with spaces are not split by cmd.exe (RAD-95).
    const spawnArgs = quoteGhArgsForSpawn(args);
    const child = spawn("gh", spawnArgs, {
      cwd: options.cwd,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
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
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        const err = new Error("Cancelled");
        err.name = "AbortError";
        reject(err);
        return;
      }
      resolve({
        stdout,
        stderr,
        code: code ?? 1,
      });
    });
  });
}

export function runGh(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return gh(args, options);
}

export async function listGhAccounts(): Promise<GhAccount[]> {
  const result = await gh(["auth", "status"]);
  return parseGhAuthStatus(`${result.stdout}\n${result.stderr}`);
}

export async function activeGhLogin(host = "github.com"): Promise<string | null> {
  const accounts = await listGhAccounts();
  return accounts.find((a) => a.host === host && a.active)?.login ?? null;
}

export async function switchGhUser(login: string, host = "github.com"): Promise<void> {
  const accounts = await listGhAccounts();
  const match = accounts.find(
    (a) => a.host === host && a.login.toLowerCase() === login.toLowerCase(),
  );
  if (!match) {
    throw new Error(`GitHub account "${login}" is not logged in on ${host}. Run: gh auth login`);
  }
  if (match.active) return;
  const result = await gh(["auth", "switch", "--hostname", host, "--user", match.login]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `gh auth switch failed for ${login}`);
  }
}

function bindFile(dir: string): string {
  return path.join(dir, "github.json");
}

export async function getRepoGithubBind(cwd: string): Promise<RepoGithubBind | null> {
  const root = await findGitRoot(cwd);
  if (!root) return null;
  try {
    const raw = await readFile(bindFile(await consoleDir(root)), "utf8");
    const parsed = parseJsonObject<RepoGithubBind>(raw);
    if (!parsed.login) return null;
    return { host: parsed.host || "github.com", login: parsed.login };
  } catch {
    return null;
  }
}

export async function bindRepoGithub(
  cwd: string,
  login: string,
  host = "github.com",
): Promise<RepoGithubBind> {
  const root = await findGitRoot(cwd);
  if (!root) throw new Error("Not inside a git repository.");
  await switchGhUser(login, host);
  const bind: RepoGithubBind = { host, login };
  const dir = await consoleDir(root);
  await mkdir(dir, { recursive: true });
  await writeJsonFile(bindFile(dir), bind);
  return bind;
}

export async function ensureRepoGithub(cwd: string): Promise<{
  login: string | null;
  switched: boolean;
  bound: boolean;
}> {
  const bind = await getRepoGithubBind(cwd);
  if (!bind) {
    return { login: await activeGhLogin(), switched: false, bound: false };
  }
  const before = await activeGhLogin(bind.host);
  if (before === bind.login) {
    return { login: bind.login, switched: false, bound: true };
  }
  await switchGhUser(bind.login, bind.host);
  return { login: bind.login, switched: true, bound: true };
}

/** Early bind snapshot for create / ready / review (RAD-95). */
export type GithubBindStatus = {
  bound: boolean;
  login: string | null;
  activeLogin: string | null;
  host: string;
  /** Non-null when the agent/human should bind before reviewed or export. */
  prompt: string | null;
};

/**
 * Surface repo gh bind without switching accounts.
 * Prefer this at create / ready / review so unbound is not discovered only at export.
 * Reads github.json only (no `gh auth status`) so create/ready stay fast on Windows.
 */
export async function describeRepoGithubBind(cwd: string): Promise<GithubBindStatus> {
  const bind = await getRepoGithubBind(cwd);
  const host = bind?.host || "github.com";
  if (!bind) {
    return {
      bound: false,
      login: null,
      activeLogin: null,
      host,
      prompt:
        "Repo unbound. Bind before reviewed/export: prgenie gh use <login> (ask which account if unsure).",
    };
  }
  return {
    bound: true,
    login: bind.login,
    activeLogin: null,
    host: bind.host,
    prompt: null,
  };
}

/** Refuse reviewed until the repo is bound (RAD-95). File bind only — no gh CLI. */
export async function requireGithubBindForReviewed(cwd: string): Promise<GithubBindStatus> {
  const status = await describeRepoGithubBind(cwd);
  if (!status.bound) {
    throw new Error(
      status.prompt ?? "Repo unbound. Bind with prgenie gh use <login> before reviewed.",
    );
  }
  return status;
}

export type { GhAccount, RepoGithubBind };
