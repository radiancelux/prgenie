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
function localBaseRef(baseRef) {
  return baseRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}
function refsAreSameBranch(a, b) {
  return localBaseRef(a).toLowerCase() === localBaseRef(b).toLowerCase();
}
function isBaseBranch(head, baseRef) {
  if (!head || head === "HEAD" || head === "DETACHED") return true;
  return refsAreSameBranch(head, baseRef);
}
async function branchExists(cwd, name) {
  const ref = localBaseRef(name);
  const result = await git(cwd, ["rev-parse", "--verify", `refs/heads/${ref}`], {
    allowFail: true
  });
  return result.code === 0;
}
async function ensureLoopFeatureBranch(cwd, options) {
  const current = await currentBranch(cwd);
  const wanted = options.requestedHead?.trim() || current;
  const here = await findGitRoot(cwd);
  const trees = await listWorktrees(cwd);
  if (wanted && !isBaseBranch(wanted, options.baseRef)) {
    const holder = trees.find((t) => t.branch === wanted);
    if (!holder || here && sameFsPath(holder.path, here)) {
      return {
        headRef: wanted,
        headSha: await gitText(cwd, ["rev-parse", wanted])
      };
    }
    const headRef2 = options.id;
    const headSha = await gitText(cwd, ["rev-parse", wanted]);
    const created2 = await git(cwd, ["branch", headRef2, wanted], { allowFail: true });
    if (created2.code !== 0 && !await branchExists(cwd, headRef2)) {
      throw new Error(`Could not create loop branch ${headRef2}: ${created2.stderr.trim()}`);
    }
    return { headRef: headRef2, headSha };
  }
  const headRef = options.id;
  if (here && isBaseBranch(current, options.baseRef)) {
    const created2 = await git(cwd, ["checkout", "-b", headRef], { allowFail: true });
    if (created2.code !== 0) {
      const switched = await git(cwd, ["checkout", headRef], { allowFail: true });
      if (switched.code !== 0) {
        throw new Error(
          `Could not create loop branch ${headRef}: ${(created2.stderr || switched.stderr).trim()}`
        );
      }
    }
    return { headRef, headSha: await gitText(cwd, ["rev-parse", "HEAD"]) };
  }
  const created = await git(cwd, ["branch", headRef], { allowFail: true });
  if (created.code !== 0 && !await branchExists(cwd, headRef)) {
    throw new Error(`Could not create loop branch ${headRef}: ${created.stderr.trim()}`);
  }
  return { headRef, headSha: await gitText(cwd, ["rev-parse", "HEAD"]) };
}
function primaryWorktreePath(trees) {
  const mains = trees.filter((t) => !t.bare && !loopWorktreeIdentity(t.path));
  return mains[0]?.path ?? trees.find((t) => !t.bare)?.path ?? null;
}
async function freeStaleLoopWorktree(cwd, treePath) {
  const here = await findGitRoot(cwd);
  if (here && sameFsPath(here, treePath)) {
    await git(treePath, ["checkout", "--detach"], { allowFail: true });
    return;
  }
  await git(cwd, ["worktree", "remove", treePath], { allowFail: true });
  await git(cwd, ["worktree", "prune"], { allowFail: true });
}
async function addLoopWorktree(cwd, dest, loop) {
  if ((0, import_node_fs.existsSync)(dest)) {
    const already = await findGitRoot(dest);
    if (already) return dest;
  }
  await (0, import_promises.mkdir)(import_node_path2.default.dirname(dest), { recursive: true });
  await git(cwd, ["worktree", "prune"], { allowFail: true });
  const trees = await listWorktrees(cwd);
  const held = trees.some((t) => t.branch === loop.headRef);
  if (!held && await branchExists(cwd, loop.headRef)) {
    const added = await git(cwd, ["worktree", "add", dest, loop.headRef], { allowFail: true });
    if (added.code === 0) return dest;
  }
  if (!held && !await branchExists(cwd, loop.headRef)) {
    const created = await git(
      cwd,
      ["worktree", "add", "-b", loop.headRef, dest, loop.headSha],
      { allowFail: true }
    );
    if (created.code === 0) return dest;
    throw new Error(
      `Could not create a worktree for loop ${loop.id} on branch ${loop.headRef}: ${created.stderr.trim()}`
    );
  }
  throw new Error(
    `Could not create a worktree for loop ${loop.id}: branch ${loop.headRef} is already checked out.`
  );
}
async function ensureWorktreeForLoop(cwd, loop, options = {}) {
  const stale = new Set(
    [...options.staleLoopIds ?? []].map((id) => id.toLowerCase())
  );
  const live = new Set(
    [...options.liveLoopIds ?? []].map((id) => id.toLowerCase())
  );
  live.add(loop.id.toLowerCase());
  let trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  if (!primary) throw new Error("No git worktree to attach a loop to.");
  const dest = loopWorktreeDir(primary, loop.id);
  const own = trees.find((t) => sameFsPath(t.path, dest));
  if (own) return own.path;
  const holders = trees.filter((t) => t.branch === loop.headRef);
  for (const holder of holders) {
    if (sameFsPath(holder.path, dest)) return holder.path;
    if (sameFsPath(holder.path, primary)) return holder.path;
    const ident = loopWorktreeIdentity(holder.path);
    if (ident && ident.id.toLowerCase() === loop.id.toLowerCase()) return holder.path;
    if (ident) {
      const otherId = ident.id.toLowerCase();
      if (live.has(otherId) && !stale.has(otherId)) continue;
      await freeStaleLoopWorktree(cwd, holder.path);
    }
  }
  const here = await findGitRoot(cwd);
  const current = await currentBranch(cwd);
  if (current === loop.headRef && here && !loopWorktreeIdentity(here)) {
    return here;
  }
  trees = await listWorktrees(cwd);
  const stillOwn = trees.find((t) => sameFsPath(t.path, dest));
  if (stillOwn) return stillOwn.path;
  if (trees.some((t) => t.branch === loop.headRef && sameFsPath(t.path, primary))) {
    return primary;
  }
  return addLoopWorktree(cwd, dest, loop);
}
async function shortLogSubject(cwd, rev = "HEAD") {
  return gitText(cwd, ["log", "-1", "--format=%s", rev]);
}

// packages/core/src/prs.ts
var import_node_crypto = require("node:crypto");
var import_promises4 = require("node:fs/promises");
var import_node_path5 = __toESM(require("node:path"), 1);

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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  let lastErr;
  for (let i = 0; i < 50; i++) {
    try {
      const handle = await (0, import_promises2.open)(lock, "wx");
      try {
        return await fn();
      } finally {
        await handle.close();
        await (0, import_promises2.unlink)(lock).catch(() => void 0);
      }
    } catch (err) {
      lastErr = err;
      await delay(20);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Timed out locking ${file}`);
}

// packages/core/src/watch.ts
var import_promises3 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"), 1);
function watchFile(dir) {
  return import_node_path4.default.join(dir, "watch.json");
}
var idleLane = () => ({
  halted: false,
  reason: null,
  exportId: null
});
function derive(inbox, queue, updatedAt) {
  const halted = inbox.halted && queue.halted;
  const reason = halted ? inbox.reason === queue.reason ? inbox.reason : inbox.reason ?? queue.reason : null;
  const exportId = inbox.exportId ?? queue.exportId;
  return { halted, reason, exportId, inbox, queue, updatedAt };
}
var idle = () => derive(idleLane(), idleLane(), (/* @__PURE__ */ new Date(0)).toISOString());
function parseLane(raw) {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw;
  return {
    halted: parsed.halted === true,
    reason: parsed.reason === "export" || parsed.reason === "stop" ? parsed.reason : null,
    exportId: typeof parsed.exportId === "string" ? parsed.exportId : null
  };
}
function parseReason(value) {
  return value === "export" || value === "stop" ? value : null;
}
async function getRepoWatch(cwd) {
  const root = await requireGitRoot(cwd);
  try {
    const raw = await (0, import_promises3.readFile)(watchFile(await consoleDir(root)), "utf8");
    const parsed = parseJsonObject(raw);
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : idle().updatedAt;
    const inbox = parseLane(parsed.inbox);
    const queue = parseLane(parsed.queue);
    if (inbox && queue) return derive(inbox, queue, updatedAt);
    const legacy = {
      halted: parsed.halted === true,
      reason: parseReason(parsed.reason),
      exportId: typeof parsed.exportId === "string" ? parsed.exportId : null
    };
    return derive(legacy, { ...legacy }, updatedAt);
  } catch {
    return idle();
  }
}
async function writeWatch(cwd, state) {
  const root = await requireGitRoot(cwd);
  await writeJsonFile(watchFile(await consoleDir(root)), state);
  return state;
}
async function resumeWatch(cwd) {
  return writeWatch(cwd, derive(idleLane(), idleLane(), (/* @__PURE__ */ new Date()).toISOString()));
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
async function readPrFile(file) {
  const pr = parseJsonObject(await (0, import_promises4.readFile)(file, "utf8"));
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
  const names = await (0, import_promises4.readdir)(dir);
  const prs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await (0, import_promises4.readFile)(import_node_path5.default.join(dir, name), "utf8");
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
async function resumeWatchForNextLoop(cwd) {
  const watch = await getRepoWatch(cwd);
  if (!watch.halted || watch.reason !== "export") return;
  if (watch.exportId) {
    try {
      const exported = await getLocalPr(cwd, watch.exportId);
      if (!isArchivedPr(exported)) return;
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith("Local PR not found:")) throw err;
    }
  }
  await resumeWatch(cwd);
}
async function createLocalPr(cwd, input = {}) {
  const root = await requireGitRoot(cwd);
  const id = newId("lp");
  const baseRef = input.base ?? await detectDefaultBase(cwd);
  const baseResolved = await git(cwd, ["rev-parse", "--verify", baseRef], {
    allowFail: true
  });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  const baseSha = baseResolved.stdout.trim();
  const requestedHead = input.head ?? await currentBranch(cwd) ?? await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const { headRef, headSha } = await ensureLoopFeatureBranch(root, {
    id,
    requestedHead,
    baseRef
  });
  const title = input.title?.trim() || await shortLogSubject(cwd, headSha).catch(() => "") || `Local PR from ${headRef}`;
  const createdAt = nowIso();
  const pr = {
    id,
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
  const others = await listLocalPrs(root);
  pr.worktreePath = await ensureWorktreeForLoop(root, pr, {
    staleLoopIds: others.filter((other) => other.id !== pr.id && isArchivedPr(other)).map((other) => other.id),
    liveLoopIds: others.filter((other) => !isArchivedPr(other)).map((other) => other.id)
  });
  await resumeWatchForNextLoop(root);
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
  const baseRef = input.base ?? await detectDefaultBase(cwd);
  const headRef = input.head ?? await currentBranch(cwd) ?? await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const existing = isBaseBranch(headRef, baseRef) ? void 0 : (await listLocalPrs(cwd)).find(
    (pr2) => pr2.headRef === headRef && !isArchivedPr(pr2)
  );
  if (existing) {
    const prevSha = existing.headSha;
    const updated = await withPrLock(cwd, existing.id, async (pr2) => {
      if (input.source) pr2.source = input.source;
      if (input.title?.trim()) pr2.title = input.title.trim();
      if (input.body?.trim()) pr2.body = input.body.trim();
      await applyHeadRefresh(cwd, pr2);
      if (pr2.status === "reviewed" && pr2.headSha !== prevSha) {
        pr2.status = "ready";
      }
    });
    updated.worktreePath = await ensureWorktreeForLoop(cwd, updated, {
      staleLoopIds: (await listLocalPrs(cwd)).filter((other) => other.id !== updated.id && isArchivedPr(other)).map((other) => other.id),
      liveLoopIds: (await listLocalPrs(cwd)).filter((other) => !isArchivedPr(other)).map((other) => other.id)
    });
    return { action: "updated", pr: updated };
  }
  const pr = await createLocalPr(cwd, input);
  return { action: "created", pr };
}

// packages/core/src/sessions.ts
var import_promises5 = require("node:fs/promises");
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
  await (0, import_promises5.appendFile)(file, `${line}
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
