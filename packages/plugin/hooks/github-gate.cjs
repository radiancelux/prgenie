"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/core/src/types.ts
var init_types = __esm({
  "packages/core/src/types.ts"() {
    "use strict";
  }
});

// packages/core/src/git.ts
function clearGitBinaryCache() {
  cachedGitBinary = void 0;
}
function formatGitMissingError(platform = process.platform) {
  if (platform === "win32") {
    return `git is not resolvable from this process. Install Git for Windows (https://git-scm.com/download/win) and ensure git.exe is on PATH, or set ${PRGENIE_GIT_ENV} to the absolute path of git.exe (e.g. C:\\Program Files\\Git\\cmd\\git.exe).`;
  }
  return `git is not resolvable from this process. Install git and ensure it is on PATH, or set ${PRGENIE_GIT_ENV} to the absolute path of the git binary.`;
}
function formatGitSpawnError(binary, err, platform = process.platform) {
  const detail = err.code ? `${err.code}: ${err.message}` : err.message;
  if (err.code === "ENOENT") {
    return formatGitMissingError(platform);
  }
  return `Failed to spawn git at "${binary}" (${detail}). ` + formatGitMissingError(platform);
}
function pathDelimiter(platform) {
  return platform === "win32" ? ";" : ":";
}
function findOnPath(names, pathEnv, exists, delimiter) {
  for (const dir of pathEnv.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = import_node_path.default.join(trimmed, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
function windowsGitCandidates(env = process.env) {
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA?.trim();
  const out = [
    import_node_path.default.join(pf, "Git", "cmd", "git.exe"),
    import_node_path.default.join(pf, "Git", "bin", "git.exe"),
    import_node_path.default.join(pf86, "Git", "cmd", "git.exe"),
    import_node_path.default.join(pf86, "Git", "bin", "git.exe")
  ];
  if (local) {
    out.push(import_node_path.default.join(local, "Programs", "Git", "cmd", "git.exe"));
    out.push(import_node_path.default.join(local, "Programs", "Git", "bin", "git.exe"));
  }
  return out;
}
function resolveGitBinary(options = {}) {
  const useCache = !options.bypassCache && options.env === void 0 && options.pathEnv === void 0 && options.existsSync === void 0 && options.platform === void 0;
  if (useCache && cachedGitBinary !== void 0) {
    return cachedGitBinary;
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? import_node_fs.existsSync;
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
function requireGitBinary(options) {
  const resolved = resolveGitBinary(options);
  if (resolved) return resolved;
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const override = env[PRGENIE_GIT_ENV]?.trim();
  if (override) {
    throw new GitBinaryError(
      `${PRGENIE_GIT_ENV} is set to "${override}" but that path does not exist. ` + formatGitMissingError(platform)
    );
  }
  throw new GitBinaryError(formatGitMissingError(platform));
}
async function git(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
    let binary;
    try {
      binary = requireGitBinary();
    } catch (err) {
      reject(err);
      return;
    }
    const child = (0, import_node_child_process.spawn)(binary, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearGitBinaryCache();
      reject(new GitBinaryError(formatGitSpawnError(binary, err)));
    });
    const onAbort2 = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort2, { once: true });
    if (options.stdin !== void 0) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort2);
      if (options.signal?.aborted) {
        const err = new Error("Cancelled");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const result = {
        stdout: stdout.replace(/\r\n/g, "\n"),
        stderr: stderr.replace(/\r\n/g, "\n"),
        code: code ?? 1
      };
      if (result.code !== 0 && !options.allowFail) {
        reject(new GitError(args, result.stderr, result.code));
        return;
      }
      resolve(result);
    });
  });
}
async function gitText(cwd, args) {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}
async function findGitRoot(cwd) {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"], {
    allowFail: true
  });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}
async function gitCommonDir(cwd) {
  const dir = await gitText(cwd, ["rev-parse", "--git-common-dir"]);
  return import_node_path.default.isAbsolute(dir) ? import_node_path.default.normalize(dir) : import_node_path.default.resolve(cwd, dir);
}
var import_node_child_process, import_node_fs, import_node_path, PRGENIE_GIT_ENV, GitError, GitBinaryError, cachedGitBinary;
var init_git = __esm({
  "packages/core/src/git.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_fs = require("node:fs");
    import_node_path = __toESM(require("node:path"), 1);
    PRGENIE_GIT_ENV = "PRGENIE_GIT";
    GitError = class extends Error {
      constructor(args, stderr, exitCode) {
        super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
        this.args = args;
        this.stderr = stderr;
        this.exitCode = exitCode;
        this.name = "GitError";
      }
    };
    GitBinaryError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "GitBinaryError";
      }
    };
  }
});

// packages/core/src/worktrees.ts
var init_worktrees = __esm({
  "packages/core/src/worktrees.ts"() {
    "use strict";
    init_git();
  }
});

// packages/core/src/plugin-dirt.ts
var init_plugin_dirt = __esm({
  "packages/core/src/plugin-dirt.ts"() {
    "use strict";
    init_git();
    init_worktrees();
  }
});

// packages/core/src/store.ts
async function consoleDir(cwd) {
  const common = await gitCommonDir(cwd);
  const dir = import_node_path2.default.join(common, "agent-console");
  await (0, import_promises.mkdir)(dir, { recursive: true });
  return dir;
}
function firstJsonObject(raw) {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
function parseJsonObject(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const slice = firstJsonObject(raw);
    if (!slice) throw new SyntaxError("No JSON object in file");
    return JSON.parse(slice);
  }
}
var import_promises, import_node_path2;
var init_store = __esm({
  "packages/core/src/store.ts"() {
    "use strict";
    import_promises = require("node:fs/promises");
    import_node_path2 = __toESM(require("node:path"), 1);
    init_git();
  }
});

// packages/core/src/watch.ts
var init_watch = __esm({
  "packages/core/src/watch.ts"() {
    "use strict";
    init_git();
    init_store();
  }
});

// packages/core/src/learnings.ts
var init_learnings = __esm({
  "packages/core/src/learnings.ts"() {
    "use strict";
    init_store();
    init_prs();
    init_prs();
  }
});

// packages/core/src/export-gate.ts
var init_export_gate = __esm({
  "packages/core/src/export-gate.ts"() {
    "use strict";
  }
});

// packages/core/src/prs.ts
var init_prs = __esm({
  "packages/core/src/prs.ts"() {
    "use strict";
    init_git();
    init_store();
    init_worktrees();
    init_types();
    init_watch();
    init_learnings();
    init_export_gate();
    init_plugin_dirt();
  }
});

// packages/core/src/progress.ts
var init_progress = __esm({
  "packages/core/src/progress.ts"() {
    "use strict";
  }
});

// packages/core/src/ci-abort.ts
var STALE_LOCK_MS;
var init_ci_abort = __esm({
  "packages/core/src/ci-abort.ts"() {
    "use strict";
    init_progress();
    STALE_LOCK_MS = 30 * 60 * 1e3;
  }
});

// packages/core/src/github.ts
function parseGhAuthStatus(text) {
  const accounts = [];
  let pending = null;
  for (const line of text.split(/\r?\n/)) {
    const loginMatch = line.match(/Logged in to (\S+) account (\S+)/i);
    if (loginMatch) {
      pending = { host: loginMatch[1], login: loginMatch[2] };
      continue;
    }
    const activeMatch = line.match(/Active account:\s*(true|false)/i);
    if (activeMatch && pending) {
      accounts.push({
        host: pending.host,
        login: pending.login,
        active: activeMatch[1].toLowerCase() === "true"
      });
      pending = null;
    }
  }
  if (pending) {
    accounts.push({ ...pending, active: false });
  }
  return accounts;
}
var init_github = __esm({
  "packages/core/src/github.ts"() {
    "use strict";
  }
});

// packages/core/src/github-ops.ts
function gh(args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const child = (0, import_node_child_process2.spawn)("gh", args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    const onAbort2 = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort2, { once: true });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort2);
      if (options.signal?.aborted) {
        const err = new Error("Cancelled");
        err.name = "AbortError";
        reject(err);
        return;
      }
      resolve({
        stdout,
        stderr,
        code: code ?? 1
      });
    });
  });
}
async function listGhAccounts() {
  const result = await gh(["auth", "status"]);
  return parseGhAuthStatus(`${result.stdout}
${result.stderr}`);
}
async function activeGhLogin(host = "github.com") {
  const accounts = await listGhAccounts();
  return accounts.find((a) => a.host === host && a.active)?.login ?? null;
}
async function switchGhUser(login, host = "github.com") {
  const accounts = await listGhAccounts();
  const match = accounts.find(
    (a) => a.host === host && a.login.toLowerCase() === login.toLowerCase()
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
function bindFile(dir) {
  return import_node_path3.default.join(dir, "github.json");
}
async function getRepoGithubBind(cwd) {
  const root = await findGitRoot(cwd);
  if (!root) return null;
  try {
    const raw = await (0, import_promises2.readFile)(bindFile(await consoleDir(root)), "utf8");
    const parsed = parseJsonObject(raw);
    if (!parsed.login) return null;
    return { host: parsed.host || "github.com", login: parsed.login };
  } catch {
    return null;
  }
}
async function ensureRepoGithub(cwd) {
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
var import_node_child_process2, import_promises2, import_node_path3;
var init_github_ops = __esm({
  "packages/core/src/github-ops.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_promises2 = require("node:fs/promises");
    import_node_path3 = __toESM(require("node:path"), 1);
    init_git();
    init_store();
    init_github();
  }
});

// packages/core/src/ci-cache.ts
var init_ci_cache = __esm({
  "packages/core/src/ci-cache.ts"() {
    "use strict";
    init_git();
  }
});

// packages/core/src/ci-failure.ts
var CI_LOG_MAX_BYTES, ANSI_RE;
var init_ci_failure = __esm({
  "packages/core/src/ci-failure.ts"() {
    "use strict";
    init_git();
    CI_LOG_MAX_BYTES = 64 * 1024;
    ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
  }
});

// packages/core/src/ci-select.ts
var SCOPABLE_PACKAGES, SCOPABLE_SET;
var init_ci_select = __esm({
  "packages/core/src/ci-select.ts"() {
    "use strict";
    init_git();
    init_plugin_dirt();
    init_prs();
    SCOPABLE_PACKAGES = ["core", "cli", "extension"];
    SCOPABLE_SET = new Set(SCOPABLE_PACKAGES);
  }
});

// packages/core/src/worktree-deps.ts
var import_node_child_process3, import_node_util, execAsync, REQUIRED_CI_BINS, OPTIONAL_CI_BINS, CI_ENV_TOOL_NAMES, CI_ENV_TOOL_ALT;
var init_worktree_deps = __esm({
  "packages/core/src/worktree-deps.ts"() {
    "use strict";
    import_node_child_process3 = require("node:child_process");
    import_node_util = require("node:util");
    init_worktrees();
    execAsync = (0, import_node_util.promisify)(import_node_child_process3.exec);
    REQUIRED_CI_BINS = ["eslint", "tsc", "tsx", "prettier"];
    OPTIONAL_CI_BINS = ["turbo", "vitest"];
    CI_ENV_TOOL_NAMES = [...REQUIRED_CI_BINS, ...OPTIONAL_CI_BINS, "typescript"];
    CI_ENV_TOOL_ALT = CI_ENV_TOOL_NAMES.join("|");
  }
});

// packages/core/src/ci-runner.ts
var import_node_child_process4, import_node_util2, execAsync2;
var init_ci_runner = __esm({
  "packages/core/src/ci-runner.ts"() {
    "use strict";
    import_node_child_process4 = require("node:child_process");
    import_node_util2 = require("node:util");
    init_ci_cache();
    init_ci_failure();
    init_ci_select();
    init_ci_abort();
    init_prs();
    init_progress();
    init_worktree_deps();
    execAsync2 = (0, import_node_util2.promisify)(import_node_child_process4.exec);
  }
});

// packages/core/src/shepherd.ts
var init_shepherd = __esm({
  "packages/core/src/shepherd.ts"() {
    "use strict";
    init_prs();
    init_learnings();
    init_github_ops();
    init_ci_runner();
    init_ci_select();
    init_progress();
  }
});

// packages/core/src/export-validation.ts
var init_export_validation = __esm({
  "packages/core/src/export-validation.ts"() {
    "use strict";
    init_ci_abort();
    init_prs();
    init_shepherd();
    init_progress();
  }
});

// packages/core/src/steward.ts
var init_steward = __esm({
  "packages/core/src/steward.ts"() {
    "use strict";
    init_export_gate();
    init_export_validation();
    init_git();
    init_prs();
    init_store();
  }
});

// packages/cli/src/github-hook.ts
var import_node_fs2 = require("node:fs");

// packages/core/src/index.ts
init_types();
init_git();

// packages/core/src/mcp-cwd.ts
init_git();

// packages/core/src/index.ts
init_worktrees();
init_plugin_dirt();
init_prs();
init_watch();

// packages/core/src/review-claim.ts
init_git();
init_prs();
init_store();

// packages/core/src/index.ts
init_steward();

// packages/core/src/doctor.ts
init_git();
init_github_ops();
init_prs();
init_watch();
init_worktrees();
init_ci_failure();
init_plugin_dirt();

// packages/core/src/export.ts
init_git();
init_github_ops();
init_prs();
init_worktrees();
init_watch();
init_progress();

// packages/core/src/index.ts
init_export_validation();
init_ci_abort();
init_progress();
init_export_gate();

// packages/core/src/sessions.ts
init_git();
init_store();

// packages/core/src/learning.ts
init_git();
init_prs();

// packages/core/src/index.ts
init_store();
init_github();
init_github_ops();
init_learnings();
init_shepherd();
init_ci_runner();
init_worktree_deps();
init_ci_select();
init_ci_failure();
init_ci_cache();

// packages/cli/src/github-hook.ts
function isPublish(command) {
  return /\bgit(\.exe)?\s+push\b/i.test(command) || /\bgh(\.exe)?\s+pr\s+create\b/i.test(command) || /\bgh(\.exe)?\s+pr\s+merge\b/i.test(command) || /\bgh(\.exe)?\s+repo\s+create\b/i.test(command);
}
function isGithubCli(command) {
  return /\bgh(\.exe)?\b/i.test(command) || /\bgit(\.exe)?\s+push\b/i.test(command);
}
function switchUser(command) {
  const match = command.match(/\bgh(?:\.exe)?\s+auth\s+switch\b[\s\S]*?--user\s+(\S+)/i);
  return match?.[1] ?? null;
}
async function main() {
  let input;
  try {
    const raw = (0, import_node_fs2.readFileSync)(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const command = String(input.command ?? "");
  const cwd = String(input.cwd ?? process.cwd());
  const root = await findGitRoot(cwd);
  if (root && isGithubCli(command)) {
    const bind = await getRepoGithubBind(root);
    const switchingTo = switchUser(command);
    if (bind && switchingTo && switchingTo.toLowerCase() !== bind.login.toLowerCase()) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message: `PR Genie: this repo is bound to GitHub account ${bind.login}. ${switchingTo} is a different login.`,
          agent_message: `This repository is bound to ${bind.login}. Do not gh auth switch to ${switchingTo}. Use prgenie gh use ${bind.login} if the bind should change.`
        })
      );
      return;
    }
    try {
      await ensureRepoGithub(root);
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          permission: "ask",
          user_message: `PR Genie could not switch to the bound GitHub account: ${err instanceof Error ? err.message : err}`,
          agent_message: "Could not switch GitHub accounts. Ask the user to run prgenie gh use <login>."
        })
      );
      return;
    }
  }
  if (isPublish(command)) {
    const bind = root ? await getRepoGithubBind(root) : null;
    const asWho = bind ? ` as ${bind.login}` : "";
    process.stdout.write(
      JSON.stringify({
        permission: "ask",
        user_message: `PR Genie: this would publish to GitHub${asWho}. Prefer a local PR Genie loop unless you explicitly want to export.`,
        agent_message: "Do not git push or gh pr create unless the user explicitly asked to export (/export). Ask whether they want to open a PR Genie local PR (/start, /steward, or /local-pr) \u2014 do not create one unless they opt in."
      })
    );
    return;
  }
  process.stdout.write(JSON.stringify({ permission: "allow" }));
}

// packages/cli/src/github-hook-bin.ts
main().catch(() => {
  process.stdout.write(
    JSON.stringify({
      permission: "ask",
      user_message: "PR Genie github gate failed unexpectedly. Allow only if you trust this command.",
      agent_message: "github-gate crashed. Do not git push or gh pr create/merge. Ask the user, or run prgenie doctor."
    })
  );
});
