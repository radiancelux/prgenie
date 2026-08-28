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

// packages/cli/src/capture-hook.ts
var import_node_fs2 = require("node:fs");

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
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"), 1);
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
      const text = line.replace(/\r$/, "");
      if (text.startsWith("worktree ")) info.path = text.slice("worktree ".length);
      else if (text.startsWith("HEAD ")) info.head = text.slice("HEAD ".length);
      else if (text.startsWith("branch ")) {
        const ref = text.slice("branch ".length);
        info.branch = ref.replace(/^refs\/heads\//, "");
      } else if (text === "bare") info.bare = true;
      else if (text === "detached") info.detached = true;
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
function loopWorktreeDir(mainPath, id) {
  return import_node_path2.default.join(import_node_path2.default.dirname(mainPath), `${import_node_path2.default.basename(mainPath)}.loops`, id);
}
async function ensureWorktreeForLoop(cwd, loop) {
  const trees = await listWorktrees(cwd);
  const existing = worktreeForBranch(trees, loop.headRef);
  if (existing) return existing;
  const current = await currentBranch(cwd);
  if (current === loop.headRef) {
    const here = await findGitRoot(cwd);
    if (here) return here;
  }
  const main2 = trees.find((t) => !t.bare)?.path;
  if (!main2) throw new Error("No git worktree to attach a loop to.");
  const dest = loopWorktreeDir(main2, loop.id);
  if ((0, import_node_fs.existsSync)(dest)) {
    const already = await findGitRoot(dest);
    if (already) return dest;
  }
  await (0, import_promises.mkdir)(import_node_path2.default.dirname(dest), { recursive: true });
  await git(cwd, ["worktree", "prune"], { allowFail: true });
  const branched = await git(cwd, ["worktree", "add", dest, loop.headRef], {
    allowFail: true
  });
  if (branched.code === 0) return dest;
  const detached = await git(cwd, ["worktree", "add", "--detach", dest, loop.headSha], {
    allowFail: true
  });
  if (detached.code === 0) return dest;
  throw new Error(
    `Could not create a worktree for loop ${loop.id} (${loop.headRef}): ${(branched.stderr || detached.stderr).trim()}`
  );
}
async function shortLogSubject(cwd, rev = "HEAD") {
  return gitText(cwd, ["log", "-1", "--format=%s", rev]);
}

// packages/core/src/prs.ts
var import_node_crypto = require("node:crypto");
var import_promises3 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"), 1);

// packages/core/src/store.ts
var import_promises2 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"), 1);
async function consoleDir(cwd) {
  const common = await gitCommonDir(cwd);
  const dir = import_node_path3.default.join(common, "agent-console");
  await (0, import_promises2.mkdir)(dir, { recursive: true });
  return dir;
}
async function prsDir(cwd) {
  const dir = import_node_path3.default.join(await consoleDir(cwd), "prs");
  await (0, import_promises2.mkdir)(dir, { recursive: true });
  return dir;
}
function prFile(dir, id) {
  return import_node_path3.default.join(dir, `${id}.json`);
}
async function sessionsFile(cwd) {
  const dir = await consoleDir(cwd);
  await (0, import_promises2.mkdir)(dir, { recursive: true });
  return import_node_path3.default.join(dir, "sessions.jsonl");
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
async function writeJsonFile(file, value) {
  const body = `${JSON.stringify(value, null, 2)}
`;
  const tmp = `${file}.${process.pid}.tmp`;
  const tmpHandle = await (0, import_promises2.open)(tmp, "w");
  try {
    await tmpHandle.writeFile(body, "utf8");
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  try {
    await (0, import_promises2.rename)(tmp, file);
    return;
  } catch {
  }
  const dest = await (0, import_promises2.open)(file, "w");
  try {
    const buf = Buffer.from(body, "utf8");
    await dest.write(buf, 0, buf.length, 0);
    await dest.truncate(buf.length);
    await dest.sync();
  } finally {
    await dest.close();
  }
  await (0, import_promises2.unlink)(tmp).catch(() => void 0);
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
  await writeJsonFile(prFile(dir, pr.id), pr);
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
  const names = await (0, import_promises3.readdir)(dir);
  const prs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await (0, import_promises3.readFile)(import_node_path4.default.join(dir, name), "utf8");
    let pr;
    try {
      pr = parseJsonObject(raw);
    } catch {
      continue;
    }
    pr.source = pr.source ?? null;
    pr.reviewRequestedSha = pr.reviewRequestedSha ?? null;
    pr.comments = (pr.comments ?? []).map(normalizeComment);
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
    worktreePath: null,
    comments: [],
    source: input.source ?? { kind: "cli" },
    createdAt,
    updatedAt: createdAt,
    reviewRequestedSha: null
  };
  await writePr(root, pr);
  pr.worktreePath = await ensureWorktreeForLoop(root, pr);
  return pr;
}
function normalizeComment(comment) {
  const role = comment.role === "agent" || comment.role === "reviewer" || comment.role === "human" ? comment.role : "human";
  return {
    ...comment,
    author: comment.author || "reviewer",
    role
  };
}
async function refreshLocalPrHead(cwd, id) {
  const pr = await getLocalPr(cwd, id);
  const named = await git(cwd, ["rev-parse", "--verify", pr.headRef], { allowFail: true });
  if (named.code !== 0) {
    const branch = await currentBranch(cwd);
    if (branch) pr.headRef = branch;
  }
  pr.headSha = await gitText(cwd, ["rev-parse", named.code === 0 ? pr.headRef : "HEAD"]);
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
}
async function hasCommitsAheadOfBase(cwd, baseRef) {
  const base = baseRef ?? await detectDefaultBase(cwd);
  const ahead = await git(cwd, ["rev-list", "--count", `${base}..HEAD`], {
    allowFail: true
  });
  if (ahead.code !== 0) return false;
  return Number(ahead.stdout.trim()) > 0;
}
async function captureAgentWork(cwd, input = {}) {
  await requireGitRoot(cwd);
  if (!await hasCommitsAheadOfBase(cwd, input.base)) {
    return {
      action: "skipped",
      reason: "no commits ahead of base"
    };
  }
  const headRef = input.head ?? await currentBranch(cwd) ?? await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const existing = (await listLocalPrs(cwd)).find(
    (pr2) => pr2.headRef === headRef && pr2.status !== "approved"
  );
  if (existing) {
    if (input.source) existing.source = input.source;
    if (input.title?.trim()) existing.title = input.title.trim();
    if (input.body?.trim()) existing.body = input.body.trim();
    const updated = await refreshLocalPrHead(cwd, existing.id);
    updated.source = existing.source;
    await writePr(cwd, updated);
    updated.worktreePath = await ensureWorktreeForLoop(cwd, updated);
    return { action: "updated", pr: updated };
  }
  const pr = await createLocalPr(cwd, input);
  return { action: "created", pr };
}

// packages/core/src/sessions.ts
var import_promises4 = require("node:fs/promises");
async function appendSession(cwd, event) {
  const root = await findGitRoot(cwd);
  if (!root) return;
  const file = await sessionsFile(root);
  const line = JSON.stringify({
    ...event,
    cwd,
    gitRoot: root,
    at: (/* @__PURE__ */ new Date()).toISOString()
  });
  await (0, import_promises4.appendFile)(file, `${line}
`, "utf8");
}

// packages/cli/src/capture-hook.ts
function inferCwd(input) {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  return process.cwd();
}
function silent() {
  process.stdout.write("{}\n");
}
async function main() {
  let input = {};
  try {
    const raw = (0, import_node_fs2.readFileSync)(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const status = String(input.status ?? "completed");
  const subagentType = String(input.subagent_type ?? "");
  const task = String(input.task ?? input.description ?? "Subagent work");
  const modified = Array.isArray(input.modified_files) ? input.modified_files : [];
  const loopCount = Number(input.loop_count ?? 0);
  const cwd = inferCwd(input);
  const root = await findGitRoot(cwd);
  if (root) {
    await appendSession(root, {
      hook: "subagentStop",
      subagent_type: subagentType,
      status,
      task,
      modified_files: modified
    });
  }
  if (status === "aborted") {
    silent();
    return;
  }
  const readOnly = subagentType === "explore" || subagentType === "shell";
  if (readOnly && modified.length === 0) {
    silent();
    return;
  }
  if (!root) {
    silent();
    return;
  }
  const result = await captureAgentWork(root, {
    title: task.slice(0, 120),
    body: typeof input.summary === "string" ? input.summary : "",
    source: {
      kind: "subagent",
      subagentType,
      subagentId: typeof input.subagent_id === "string" ? input.subagent_id : void 0,
      task
    }
  });
  if (result.action === "skipped") {
    if (modified.length > 0 && loopCount === 0) {
      process.stdout.write(
        JSON.stringify({
          followup_message: "PR Genie: the subagent changed files but did not commit. Commit on the current branch if this should become a local PR. Do not git push."
        }) + "\n"
      );
      return;
    }
    silent();
    return;
  }
  const pr = result.pr;
  if (!pr) {
    silent();
    return;
  }
  process.stdout.write(
    JSON.stringify({
      followup_message: `PR Genie ${result.action} local PR ${pr.id} (${pr.status}) on ${pr.headRef}. It is on the developer's watch list. Do not git push or gh pr create.`
    }) + "\n"
  );
}
main().catch(() => {
  silent();
});
