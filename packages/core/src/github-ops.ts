import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findGitRoot } from "./git.js";
import { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";
import { parseGhAuthStatus, type GhAccount, type RepoGithubBind } from "./github.js";

export type GhExecutable = { file: string; kind: "exe" | "cmd"; prefixArgs?: string[] };

export type GhRunOptions = {
  cwd?: string;
  signal?: AbortSignal;
  /** Test-only override for gh resolution (142-R5). */
  ghExecutable?: GhExecutable;
};

/**
 * Quote one argv for cmd.exe when spawning a gh.cmd / gh.bat shim (142-R3).
 * Multiline payloads must use `--body-file` (RAD-129).
 *
 * Double quotes alone do **not** stop `%VAR%` expansion under cmd.exe — use `escapeCmdArg()`.
 */
export function quoteWindowsShellArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/[\r\n]/.test(arg)) {
    throw new Error(
      "Refusing to pass a multiline argument through Windows cmd.exe argv (RAD-129). Use --body-file instead.",
    );
  }
  if (/^[A-Za-z0-9_./:\\@+=,:-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Legacy helper for callers that still quote before cmd.exe; prefer `escapeCmdArg()` for `%`. */
export function quoteGhArgsForSpawn(args: string[]): string[] {
  if (process.platform !== "win32") return args;
  return args.map(quoteWindowsShellArg);
}

/** Escape one argv token for `cmd.exe /d /s /c` when the gh shim is gh.cmd (142-R3). */
export function escapeCmdArg(arg: string): string {
  if (/[\r\n]/.test(arg)) {
    throw new Error(
      "Refusing to pass a multiline argument through Windows cmd.exe argv (RAD-129). Use --body-file instead.",
    );
  }
  if (arg.length === 0) return '""';
  if (!arg.includes("%")) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  const parts = arg.split("%");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const trailingEmpty = i === parts.length - 1 && parts[i] === "";
      out += trailingEmpty ? '^%"' : "^%";
    }
    const segment = parts[i]!;
    const isTrailingEmpty = i === parts.length - 1 && segment === "";
    if (!isTrailingEmpty) {
      out += `"${segment.replace(/"/g, '""')}"`;
    }
  }
  return out;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(path.delimiter).filter(Boolean);
}

/** Resolve gh on PATH: gh.exe before gh.cmd/gh.bat on Windows (142-R1). */
export function resolveGhExecutable(env: NodeJS.ProcessEnv = process.env): GhExecutable | null {
  if (process.platform !== "win32") {
    return { file: "gh", kind: "exe" };
  }
  for (const dir of pathEntries(env)) {
    const exe = path.join(dir, "gh.exe");
    if (existsSync(exe)) return { file: exe, kind: "exe" };
  }
  for (const dir of pathEntries(env)) {
    for (const name of ["gh.cmd", "gh.bat"]) {
      const shim = path.join(dir, name);
      if (existsSync(shim)) return { file: shim, kind: "cmd" };
    }
  }
  return null;
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

/** `gh pr edit` argv using `--body-file` when body is set (RAD-150). Target is the PR URL from `gh pr view`. */
export function githubPrEditArgs(options: {
  prUrl: string;
  title?: string;
  bodyFile?: string;
}): string[] {
  const prUrl = options.prUrl.trim();
  if (!prUrl) throw new Error("gh pr edit requires the PR URL from gh pr view");
  const args = ["pr", "edit", prUrl];
  if (options.title?.trim()) {
    args.push("--title", options.title.trim());
  }
  if (options.bodyFile) {
    args.push("--body-file", options.bodyFile);
  }
  return args;
}

function inlineGhBody(args: string[]): string | null {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx >= 0 && bodyIdx + 1 < args.length) return args[bodyIdx + 1]!;
  const bIdx = args.indexOf("-b");
  if (bIdx >= 0 && bIdx + 1 < args.length) return args[bIdx + 1]!;
  const eq = args.find((a) => a.startsWith("--body="));
  if (eq) return eq.slice("--body=".length);
  return null;
}

/** Swap inline body flags for `--body-file <path>` (142-R6, RAD-129). */
export function replaceGhBodyWithFile(args: string[], bodyFile: string): string[] {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx >= 0 && bodyIdx + 1 < args.length) {
    const next = args.slice();
    next.splice(bodyIdx, 2, "--body-file", bodyFile);
    return next;
  }
  const bIdx = args.indexOf("-b");
  if (bIdx >= 0 && bIdx + 1 < args.length) {
    const next = args.slice();
    next.splice(bIdx, 2, "--body-file", bodyFile);
    return next;
  }
  const eqIdx = args.findIndex((a) => a.startsWith("--body="));
  if (eqIdx >= 0) {
    const next = args.slice();
    next.splice(eqIdx, 1, "--body-file", bodyFile);
    return next;
  }
  return args;
}

/**
 * Spawn GitHub CLI without cmd.exe when `gh.exe` is on PATH (142-R2).
 * Node passes argv to CreateProcessW as UTF-16 — no OEM code-page conversion for titles.
 * We do not use process-wide `chcp 65001` (does not stop `%VAR%` expansion) or `gh api`
 * with a JSON file (export must keep `gh pr create` / `--body-file`).
 */
function gh(
  args: string[],
  options: GhRunOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }

    const resolved = options.ghExecutable ?? resolveGhExecutable();
    if (!resolved) {
      reject(new Error("gh CLI not found on PATH (install GitHub CLI or add it to PATH)"));
      return;
    }

    const prefix = resolved.prefixArgs ?? [];
    let child;
    if (resolved.kind === "exe") {
      child = spawn(resolved.file, [...prefix, ...args], {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      const comSpec = process.env.ComSpec ?? "cmd.exe";
      const inner = [escapeCmdArg(resolved.file), ...args.map(escapeCmdArg)].join(" ");
      // cmd /d /s /c expects ""<quoted-cmd>" "<arg1>" ..."" (142-R3).
      const line = `"${inner}"`;
      child = spawn(comSpec, ["/d", "/s", "/c", line], {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

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

/**
 * Run `gh` with argv. Inline body flags (`--body`, `-b`, `--body=`) rewrite to a temp
 * `--body-file` so multiline / `%VAR%` payloads never travel through cmd.exe argv (142-R6).
 */
export function runGh(
  args: string[],
  options: GhRunOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const body = inlineGhBody(args);
  if (body !== null) {
    return withGhBodyFile(body, (bodyFile) => gh(replaceGhBodyWithFile(args, bodyFile), options));
  }
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
