import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { findGitRoot } from "./git.js";
import { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";
import {
  parseGhAuthStatus,
  type GhAccount,
  type RepoGithubBind,
} from "./github.js";

function gh(
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd: options.cwd,
      windowsHide: true,
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
    child.on("close", (code) => {
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
  options: { cwd?: string } = {},
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

export async function switchGhUser(
  login: string,
  host = "github.com",
): Promise<void> {
  const accounts = await listGhAccounts();
  const match = accounts.find(
    (a) => a.host === host && a.login.toLowerCase() === login.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `GitHub account "${login}" is not logged in on ${host}. Run: gh auth login`,
    );
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

export async function getRepoGithubBind(
  cwd: string,
): Promise<RepoGithubBind | null> {
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

export type { GhAccount, RepoGithubBind };
