"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var STATUSES = [
  "draft",
  "ready",
  "approved",
  "changes_requested"
];

// packages/core/src/git.ts
var import_node_child_process = require("node:child_process");
var import_node_path = __toESM(require("node:path"), 1);
var GitError = class extends Error {
  constructor(args, stderr, exitCode) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.name = "GitError";
  }
};
async function git(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)("git", args, {
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
    child.on("error", reject);
    if (options.stdin !== void 0) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    child.on("close", (code) => {
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
async function requireGitRoot(cwd) {
  const root = await findGitRoot(cwd);
  if (!root) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  return root;
}

// packages/core/src/worktrees.ts
async function listWorktrees(cwd) {
  const { stdout } = await git(cwd, ["worktree", "list", "--porcelain"]);
  const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const trees = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const info = {
      path: "",
      head: "",
      branch: null,
      bare: false,
      detached: false
    };
    for (const line of lines) {
      if (line.startsWith("worktree ")) info.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) info.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        info.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") info.bare = true;
      else if (line === "detached") info.detached = true;
    }
    if (info.path) trees.push(info);
  }
  return trees;
}
async function currentBranch(cwd) {
  const result = await git(cwd, ["branch", "--show-current"], { allowFail: true });
  if (result.code !== 0) return null;
  const name = result.stdout.trim();
  return name || null;
}
async function detectDefaultBase(cwd) {
  const originHead = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    allowFail: true
  });
  if (originHead.code === 0) {
    return originHead.stdout.trim().replace(/^refs\/remotes\//, "");
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = await git(cwd, ["rev-parse", "--verify", candidate], {
      allowFail: true
    });
    if (probe.code === 0) return candidate;
  }
  return "HEAD";
}
function worktreeForBranch(trees, branch) {
  const match = trees.find((t) => t.branch === branch);
  return match?.path ?? null;
}
async function userName(cwd) {
  const result = await git(cwd, ["config", "user.name"], { allowFail: true });
  return result.stdout.trim() || "local";
}
async function shortLogSubject(cwd, rev = "HEAD") {
  return gitText(cwd, ["log", "-1", "--format=%s", rev]);
}

// packages/core/src/prs.ts
var import_node_crypto = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"), 1);

// packages/core/src/store.ts
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"), 1);
async function consoleDir(cwd) {
  const common = await gitCommonDir(cwd);
  return import_node_path2.default.join(common, "agent-console");
}
async function prsDir(cwd) {
  const dir = import_node_path2.default.join(await consoleDir(cwd), "prs");
  await (0, import_promises.mkdir)(dir, { recursive: true });
  return dir;
}
function prFile(dir, id) {
  return import_node_path2.default.join(dir, `${id}.json`);
}

// packages/core/src/prs.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId(prefix) {
  return `${prefix}-${(0, import_node_crypto.randomBytes)(4).toString("hex")}`;
}
async function writePr(cwd, pr) {
  const dir = await prsDir(cwd);
  await (0, import_promises2.writeFile)(prFile(dir, pr.id), JSON.stringify(pr, null, 2), "utf8");
  await git(cwd, [
    "update-ref",
    `refs/local-pr/${pr.id}/head`,
    pr.headSha
  ]);
  await git(cwd, ["update-ref", `refs/local-pr/${pr.id}/base`, pr.baseSha]);
  const note = JSON.stringify({
    id: pr.id,
    title: pr.title,
    status: pr.status,
    headRef: pr.headRef,
    baseRef: pr.baseRef
  });
  await git(
    cwd,
    ["notes", "--ref=local-pr", "add", "-f", "-m", note, pr.headSha],
    { allowFail: true }
  );
}
async function listLocalPrs(cwd) {
  await requireGitRoot(cwd);
  const dir = await prsDir(cwd);
  const names = await (0, import_promises2.readdir)(dir);
  const prs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await (0, import_promises2.readFile)(import_node_path3.default.join(dir, name), "utf8");
    const pr = JSON.parse(raw);
    pr.source = pr.source ?? null;
    prs.push(pr);
  }
  prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const trees = await listWorktrees(cwd);
  for (const pr of prs) {
    pr.worktreePath = worktreeForBranch(trees, pr.headRef);
  }
  return prs;
}
async function getLocalPr(cwd, id) {
  const prs = await listLocalPrs(cwd);
  const pr = prs.find((p) => p.id === id || p.id.startsWith(id));
  if (!pr) throw new Error(`Local PR not found: ${id}`);
  return pr;
}
async function createLocalPr(cwd, input = {}) {
  const root = await requireGitRoot(cwd);
  const headRef = input.head ?? await currentBranch(cwd) ?? await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headSha = await gitText(cwd, ["rev-parse", input.head ?? "HEAD"]);
  const baseRef = input.base ?? await detectDefaultBase(cwd);
  const baseResolved = await git(cwd, ["rev-parse", "--verify", baseRef], {
    allowFail: true
  });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  const baseSha = baseResolved.stdout.trim();
  const trees = await listWorktrees(root);
  const title = input.title?.trim() || await shortLogSubject(cwd, headSha).catch(() => "") || `Local PR from ${headRef}`;
  const createdAt = nowIso();
  const pr = {
    id: newId("lp"),
    title,
    body: input.body?.trim() ?? "",
    status: "draft",
    headRef,
    baseRef,
    headSha,
    baseSha,
    worktreePath: worktreeForBranch(trees, headRef),
    comments: [],
    source: input.source ?? { kind: "cli" },
    createdAt,
    updatedAt: createdAt
  };
  await writePr(root, pr);
  return pr;
}
async function setLocalPrStatus(cwd, id, status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const pr = await getLocalPr(cwd, id);
  pr.status = status;
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
}
async function addLocalPrComment(cwd, id, body) {
  const text = body.trim();
  if (!text) throw new Error("Comment body is empty");
  const pr = await getLocalPr(cwd, id);
  const comment = {
    id: newId("c"),
    body: text,
    createdAt: nowIso(),
    author: await userName(cwd)
  };
  pr.comments.push(comment);
  if (pr.status === "ready" || pr.status === "approved") {
    pr.status = "changes_requested";
  }
  pr.updatedAt = comment.createdAt;
  await writePr(cwd, pr);
  return pr;
}
async function getLocalPrDiff(cwd, id, options = {}) {
  const pr = await getLocalPr(cwd, id);
  const args = options.stat ? ["diff", "--stat", `${pr.baseSha}...${pr.headSha}`] : ["diff", `${pr.baseSha}...${pr.headSha}`];
  const { stdout } = await git(cwd, args);
  const max = options.maxBytes ?? 2e5;
  if (stdout.length > max) {
    return `${stdout.slice(0, max)}

... truncated (${stdout.length} bytes) ...`;
  }
  return stdout;
}
async function getLocalPrNameStatus(cwd, id) {
  const pr = await getLocalPr(cwd, id);
  const { stdout } = await git(cwd, [
    "diff",
    "--name-status",
    `${pr.baseSha}...${pr.headSha}`
  ]);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [status, ...rest] = line.split("	");
    return { status, path: rest.join("	") };
  });
}

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

// packages/core/src/github-ops.ts
var import_node_child_process2 = require("node:child_process");
var import_promises3 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"), 1);
function gh(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process2.spawn)("gh", args, {
      cwd: options.cwd,
      windowsHide: true,
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
    child.on("close", (code) => {
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
async function switchGhUser(login, host = "github.com") {
  const accounts = await listGhAccounts();
  const match = accounts.find(
    (a) => a.host === host && a.login.toLowerCase() === login.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `GitHub account "${login}" is not logged in on ${host}. Run: gh auth login`
    );
  }
  if (match.active) return;
  const result = await gh(["auth", "switch", "--hostname", host, "--user", match.login]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `gh auth switch failed for ${login}`);
  }
}
function bindFile(dir) {
  return import_node_path4.default.join(dir, "github.json");
}
async function getRepoGithubBind(cwd) {
  const root = await findGitRoot(cwd);
  if (!root) return null;
  try {
    const raw = await (0, import_promises3.readFile)(bindFile(await consoleDir(root)), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.login) return null;
    return { host: parsed.host || "github.com", login: parsed.login };
  } catch {
    return null;
  }
}
async function bindRepoGithub(cwd, login, host = "github.com") {
  const root = await findGitRoot(cwd);
  if (!root) throw new Error("Not inside a git repository.");
  await switchGhUser(login, host);
  const bind = { host, login };
  const dir = await consoleDir(root);
  await (0, import_promises3.mkdir)(dir, { recursive: true });
  await (0, import_promises3.writeFile)(bindFile(dir), JSON.stringify(bind, null, 2), "utf8");
  return bind;
}

// packages/cli/src/mcp.ts
function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}
`);
}
function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
async function repoCwd() {
  const cwd = process.cwd();
  const root = await findGitRoot(cwd);
  if (!root) throw new Error("Not inside a git repository.");
  return cwd;
}
async function handleTool(name, args) {
  if (name === "gh_list" || name === "github_list") {
    return listGhAccounts();
  }
  const cwd = typeof args.cwd === "string" ? args.cwd : await repoCwd();
  switch (name) {
    case "gh_status":
    case "github_status":
      return {
        accounts: await listGhAccounts(),
        bound: await getRepoGithubBind(cwd)
      };
    case "gh_use":
    case "github_use":
      return bindRepoGithub(cwd, String(args.login ?? ""));
    case "list_worktrees":
      return listWorktrees(cwd);
    case "list_local_prs":
      return listLocalPrs(cwd);
    case "create_local_pr":
      return createLocalPr(cwd, {
        title: typeof args.title === "string" ? args.title : void 0,
        body: typeof args.body === "string" ? args.body : void 0,
        base: typeof args.base === "string" ? args.base : void 0,
        head: typeof args.head === "string" ? args.head : void 0
      });
    case "get_local_pr":
      return getLocalPr(cwd, String(args.id ?? ""));
    case "set_status":
      return setLocalPrStatus(cwd, String(args.id ?? ""), args.status);
    case "add_comment":
      return addLocalPrComment(cwd, String(args.id ?? ""), String(args.body ?? ""));
    case "get_diff":
      return {
        files: await getLocalPrNameStatus(cwd, String(args.id ?? "")),
        diff: await getLocalPrDiff(cwd, String(args.id ?? ""), { maxBytes: 8e4 })
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
var tools = [
  {
    name: "list_worktrees",
    description: "Discover existing git worktrees. Does not create or delete them.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "list_local_prs",
    description: "List unpublished local pull requests in this repository.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "create_local_pr",
    description: "Create a local PR (unpublished review packet) from the current branch or a named head. Do not git push or gh pr create.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "get_local_pr",
    description: "Show one local PR by id (prefix allowed).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "set_status",
    description: "Set local PR status: draft, ready, approved, changes_requested.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["draft", "ready", "approved", "changes_requested"] },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "add_comment",
    description: "Add a local review comment. Moves ready/approved packets back to changes_requested.",
    inputSchema: {
      type: "object",
      required: ["id", "body"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "get_diff",
    description: "Return name-status and diff for a local PR.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "gh_list",
    description: "List GitHub CLI accounts (gh auth status). Does not switch.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "gh_status",
    description: "Show GitHub CLI accounts and which login this repo is bound to.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "gh_use",
    description: "Bind this git repository to a gh login (writes .git/agent-console/github.json) and run gh auth switch. Does not bind other repos.",
    inputSchema: {
      type: "object",
      required: ["login"],
      properties: { login: { type: "string" }, cwd: { type: "string" } }
    }
  }
];
async function onRequest(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  try {
    if (method === "initialize") {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      ok(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: "prgenie", version: "0.1.0" }
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      return;
    }
    if (method === "notifications/cancelled") {
      return;
    }
    if (method === "tools/list") {
      ok(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = params.arguments ?? {};
      const result = await handleTool(name, args);
      ok(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      });
      return;
    }
    if (method === "ping") {
      ok(id, {});
      return;
    }
    if (id === void 0) return;
    fail(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (id === void 0) return;
    fail(id, -32e3, err instanceof Error ? err.message : String(err));
  }
}
async function startMcp() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    void drain();
  });
  async function drain() {
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line || /^Content-Length:/i.test(line)) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method) await onRequest(msg);
    }
  }
}

// packages/cli/src/mcp-bin.ts
void startMcp();
