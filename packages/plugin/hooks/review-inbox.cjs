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

// packages/cli/src/review-hook.ts
var import_node_fs2 = require("node:fs");

// packages/core/src/types.ts
var COMMENT_STATUSES = ["open", "addressed", "resolved"];

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
function worktreeForLoop(trees, loop) {
  const primary = primaryWorktreePath(trees);
  const dest = primary ? loopWorktreeDir(primary, loop.id) : null;
  if (dest) {
    const own = trees.find((t) => sameFsPath(t.path, dest));
    if (own) return own.path;
  }
  const onBranch = trees.filter((t) => t.branch === loop.headRef);
  const onPrimary = onBranch.find((t) => primary && sameFsPath(t.path, primary));
  if (onPrimary) return onPrimary.path;
  const ownLoops = onBranch.find((t) => {
    const ident = loopWorktreeIdentity(t.path);
    return ident && ident.id.toLowerCase() === loop.id.toLowerCase();
  });
  return ownLoops?.path ?? null;
}
function sameFsPath(a, b) {
  try {
    const leftStat = (0, import_node_fs.statSync)(a);
    const rightStat = (0, import_node_fs.statSync)(b);
    if (leftStat.ino !== 0 && leftStat.ino === rightStat.ino && leftStat.dev === rightStat.dev) {
      return true;
    }
  } catch {
  }
  const canon = (p) => {
    const normalized = import_node_path2.default.resolve(p);
    try {
      return import_node_fs.realpathSync.native(normalized);
    } catch {
      try {
        return (0, import_node_fs.realpathSync)(normalized);
      } catch {
        return normalized;
      }
    }
  };
  const left = canon(a);
  const right = canon(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function loopWorktreeDir(mainPath, id) {
  return import_node_path2.default.join(import_node_path2.default.dirname(mainPath), `${import_node_path2.default.basename(mainPath)}.loops`, id);
}
function loopWorktreeIdentity(absPath) {
  const resolved = import_node_path2.default.resolve(absPath);
  const parent = import_node_path2.default.dirname(resolved);
  const loopsDir = import_node_path2.default.basename(parent);
  if (!loopsDir.endsWith(".loops")) return null;
  const id = import_node_path2.default.basename(resolved);
  if (!/^lp-[0-9a-f]{8}$/i.test(id)) return null;
  return {
    primaryPath: import_node_path2.default.join(import_node_path2.default.dirname(parent), loopsDir.slice(0, -".loops".length)),
    id
  };
}
function primaryWorktreePath(trees) {
  const mains = trees.filter((t) => !t.bare && !loopWorktreeIdentity(t.path));
  return mains[0]?.path ?? trees.find((t) => !t.bare)?.path ?? null;
}

// packages/core/src/prs.ts
var import_promises2 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"), 1);

// packages/core/src/store.ts
var import_promises = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"), 1);
async function consoleDir(cwd) {
  const common = await gitCommonDir(cwd);
  const dir = import_node_path3.default.join(common, "agent-console");
  await (0, import_promises.mkdir)(dir, { recursive: true });
  return dir;
}
async function prsDir(cwd) {
  const dir = import_node_path3.default.join(await consoleDir(cwd), "prs");
  await (0, import_promises.mkdir)(dir, { recursive: true });
  return dir;
}
function prFile(dir, id) {
  return import_node_path3.default.join(dir, `${id}.json`);
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
  const tmpHandle = await (0, import_promises.open)(tmp, "w");
  try {
    await tmpHandle.writeFile(body, "utf8");
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
  try {
    await (0, import_promises.rename)(tmp, file);
    return;
  } catch {
  }
  const dest = await (0, import_promises.open)(file, "w");
  try {
    const buf = Buffer.from(body, "utf8");
    await dest.write(buf, 0, buf.length, 0);
    await dest.truncate(buf.length);
    await dest.sync();
  } finally {
    await dest.close();
  }
  await (0, import_promises.unlink)(tmp).catch(() => void 0);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  let lastErr;
  for (let i = 0; i < 50; i++) {
    try {
      const handle = await (0, import_promises.open)(lock, "wx");
      try {
        return await fn();
      } finally {
        await handle.close();
        await (0, import_promises.unlink)(lock).catch(() => void 0);
      }
    } catch (err) {
      lastErr = err;
      await delay(20);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Timed out locking ${file}`);
}

// packages/core/src/prs.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
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
async function readPrFile(file) {
  const pr = parseJsonObject(await (0, import_promises2.readFile)(file, "utf8"));
  pr.source = pr.source ?? null;
  pr.reviewRequestedSha = pr.reviewRequestedSha ?? null;
  pr.comments = (pr.comments ?? []).map(normalizeComment);
  return pr;
}
async function withPrLock(cwd, id, fn) {
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = await readPrFile(file);
    await fn(pr);
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}
async function applyHeadRefresh(cwd, pr) {
  const named = await git(cwd, ["rev-parse", "--verify", pr.headRef], { allowFail: true });
  if (named.code !== 0) {
    const branch = await currentBranch(cwd);
    if (branch) pr.headRef = branch;
  }
  pr.headSha = await gitText(cwd, ["rev-parse", named.code === 0 ? pr.headRef : "HEAD"]);
  pr.updatedAt = nowIso();
}
function isArchivedPr(pr) {
  return pr.status === "approved";
}
async function listLocalPrs(cwd) {
  await requireGitRoot(cwd);
  const dir = await prsDir(cwd);
  const names = await (0, import_promises2.readdir)(dir);
  const prs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await (0, import_promises2.readFile)(import_node_path4.default.join(dir, name), "utf8");
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
    pr.worktreePath = worktreeForLoop(trees, pr);
  }
  return prs;
}
async function getLocalPr(cwd, id) {
  const prs = await listLocalPrs(cwd);
  const pr = prs.find((p) => p.id === id || p.id.startsWith(id));
  if (!pr) throw new Error(`Local PR not found: ${id}`);
  return pr;
}
function inferCommentStatus(comment, role) {
  if (comment.status && COMMENT_STATUSES.includes(comment.status)) return comment.status;
  if (comment.resolvedAt) return "resolved";
  if (comment.replyTo || role === "agent") return "resolved";
  return "open";
}
function normalizeComment(comment) {
  const role = comment.role === "agent" || comment.role === "reviewer" || comment.role === "human" ? comment.role : "human";
  return {
    ...comment,
    author: comment.author || "reviewer",
    role,
    status: inferCommentStatus(comment, role)
  };
}
function isFindingComment(comment) {
  const c = normalizeComment(comment);
  if (c.role !== "human" && c.role !== "reviewer") return false;
  if (c.replyTo) return false;
  return true;
}
function pendingReviewComments(pr) {
  return (pr.comments ?? []).map(normalizeComment).filter((c) => isFindingComment(c) && c.status === "open");
}
function formatReviewInbox(pr) {
  if (pr.status !== "changes_requested") return null;
  const pending = pendingReviewComments(pr);
  if (pending.length === 0) return null;
  const lines = [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on branch ${pr.headRef} has review comments for the agent working this loop.`,
    `Status is ${pr.status}. Address each open comment with MCP address_comment (this loop id, that commentId, and a reply). Addressing the last open finding sets the loop to ready and posts Review requested. The reviewer resolves addressed comments. Do not git push.`,
    ""
  ];
  for (const comment of pending) {
    const who = comment.role === "reviewer" ? `Reviewer (${comment.author})` : `Human (${comment.author})`;
    const loc = comment.path ? ` @ ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
    lines.push(`${who} [${comment.id}] open${loc} at ${comment.createdAt}:`);
    lines.push(comment.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
function shouldSpawnReviewer(pr) {
  return pr.status === "ready" && (pr.reviewRequestedSha ?? null) !== pr.headSha;
}
function formatSpawnReviewer(pr) {
  return [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on ${pr.headRef} is ready.`,
    'That is the review request. add_comment role=agent "Review requested." if you have not already. Do not git push.',
    "You are the implementor. Do not review this loop yourself. The reviewer chat should list_local_prs (status=ready) and Task a generalPurpose subagent per loop. Do not await those Tasks in the listen loop.",
    "If you are covering review in this conversation because no reviewer chat exists, Task one generalPurpose reviewer for this id. If several loops are ready, Task one reviewer subagent each, in parallel. Do not sit waiting on them."
  ].join("\n");
}
async function markReviewRequested(cwd, id) {
  return withPrLock(cwd, id, (pr) => {
    pr.reviewRequestedSha = pr.headSha;
    pr.updatedAt = nowIso();
  });
}
async function findLocalPrForCurrentBranch(cwd) {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const matches = (await listLocalPrs(cwd)).filter(
    (pr) => pr.headRef === branch && !isArchivedPr(pr)
  );
  if (matches.length === 0) return null;
  return matches.find((pr) => pr.status === "changes_requested") ?? matches[0];
}
async function findLocalPrForCurrentWorktree(cwd) {
  const byBranch = await findLocalPrForCurrentBranch(cwd);
  if (byBranch) return byBranch;
  const branch = await currentBranch(cwd);
  if (branch) return null;
  const root = await findGitRoot(cwd);
  if (!root) return null;
  const live = (await listLocalPrs(cwd)).filter((pr) => !isArchivedPr(pr) && pr.worktreePath);
  return live.find((pr) => sameFsPath(pr.worktreePath ?? "", root)) ?? null;
}
async function refreshLocalPrHead(cwd, id) {
  return withPrLock(cwd, id, (pr) => applyHeadRefresh(cwd, pr));
}

// packages/cli/src/review-hook.ts
function inferCwd(input) {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  return process.cwd();
}
function eventName(input) {
  return String(input.hook_event_name ?? input.event ?? "");
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
  const event = eventName(input);
  const loopCount = Number(input.loop_count ?? 0);
  const cwd = inferCwd(input);
  const root = await findGitRoot(cwd);
  if (!root) {
    silent();
    return;
  }
  const pr = await findLocalPrForCurrentWorktree(root);
  if (!pr) {
    silent();
    return;
  }
  const inbox = formatReviewInbox(pr);
  if (event === "sessionStart") {
    if (!inbox) {
      silent();
      return;
    }
    process.stdout.write(JSON.stringify({ additional_context: inbox }) + "\n");
    return;
  }
  if (event === "subagentStop") {
    if (!inbox || loopCount >= 2) {
      silent();
      return;
    }
    process.stdout.write(JSON.stringify({ followup_message: inbox }) + "\n");
    return;
  }
  if (event === "stop") {
    if (loopCount >= 1) {
      silent();
      return;
    }
    const pending = pendingReviewComments(pr);
    const newest = pending[pending.length - 1];
    if (newest?.role === "human" && inbox) {
      process.stdout.write(JSON.stringify({ followup_message: inbox }) + "\n");
      return;
    }
    if (pr.status === "ready") {
      const fresh = await refreshLocalPrHead(root, pr.id);
      if (shouldSpawnReviewer(fresh)) {
        await markReviewRequested(root, fresh.id);
        process.stdout.write(JSON.stringify({ followup_message: formatSpawnReviewer(fresh) }) + "\n");
        return;
      }
    }
    silent();
    return;
  }
  silent();
}
main().catch(() => {
  silent();
});
