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
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
var STATUSES, COMMENT_ROLES, COMMENT_STATUSES;
var init_types = __esm({
  "packages/core/src/types.ts"() {
    "use strict";
    STATUSES = [
      "draft",
      "ready",
      "changes_requested",
      "reviewed",
      "approved"
    ];
    COMMENT_ROLES = ["human", "agent", "reviewer"];
    COMMENT_STATUSES = ["open", "addressed", "resolved"];
  }
});

// packages/core/src/git.ts
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
var import_node_child_process, import_node_path, GitError;
var init_git = __esm({
  "packages/core/src/git.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_path = __toESM(require("node:path"), 1);
    GitError = class extends Error {
      constructor(args, stderr, exitCode) {
        super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
        this.args = args;
        this.stderr = stderr;
        this.exitCode = exitCode;
        this.name = "GitError";
      }
    };
  }
});

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
async function checkoutPrimaryOffLoop(primary, loop) {
  const base = localBaseRef(loop.baseRef);
  if (!base || base === loop.headRef) return false;
  const branch = await currentBranch(primary);
  if (branch !== loop.headRef) return false;
  const switched = await git(primary, ["checkout", base], { allowFail: true });
  return switched.code === 0;
}
async function pruneArchivedLoopWorktree(cwd, loop, options = {}) {
  const trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  if (!primary) return false;
  const dest = loopWorktreeDir(primary, loop.id);
  const extra = trees.find((t) => sameFsPath(t.path, dest));
  if (!extra) return false;
  const ident = loopWorktreeIdentity(extra.path);
  if (ident && ident.id.toLowerCase() !== loop.id.toLowerCase()) return false;
  const here = await findGitRoot(cwd);
  if (here && sameFsPath(here, extra.path)) return false;
  if (sameFsPath(extra.path, primary)) return false;
  const keep = options.keepPaths ?? [];
  if (keep.some((p) => sameFsPath(p, extra.path))) return false;
  const otherLoops = trees.filter((t) => {
    const other = loopWorktreeIdentity(t.path);
    return other && other.id.toLowerCase() !== loop.id.toLowerCase();
  });
  if (otherLoops.some((t) => sameFsPath(t.path, extra.path))) return false;
  const removed = await git(cwd, ["worktree", "remove", extra.path], { allowFail: true });
  if (removed.code !== 0) return false;
  await git(cwd, ["worktree", "prune"], { allowFail: true });
  return true;
}
async function releaseArchivedLoop(cwd, loop) {
  const trees = await listWorktrees(cwd);
  const primary = primaryWorktreePath(trees);
  const checkedOutBase = primary ? await checkoutPrimaryOffLoop(primary, loop) : false;
  const keepPaths = trees.filter((t) => {
    const ident = loopWorktreeIdentity(t.path);
    return ident && ident.id.toLowerCase() !== loop.id.toLowerCase();
  }).map((t) => t.path);
  const prunedWorktree = await pruneArchivedLoopWorktree(cwd, loop, { keepPaths });
  const here = await findGitRoot(cwd);
  const dest = primary ? loopWorktreeDir(primary, loop.id) : null;
  const stillExtra = dest ? (await listWorktrees(cwd)).some((t) => sameFsPath(t.path, dest)) : false;
  const reopen = Boolean(stillExtra && here && dest && sameFsPath(here, dest));
  return { checkedOutBase, prunedWorktree, primaryPath: primary, reopen };
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
    const created = await git(cwd, ["worktree", "add", "-b", loop.headRef, dest, loop.headSha], {
      allowFail: true
    });
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
  const stale = new Set([...options.staleLoopIds ?? []].map((id) => id.toLowerCase()));
  const live = new Set([...options.liveLoopIds ?? []].map((id) => id.toLowerCase()));
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
async function userName(cwd) {
  const result = await git(cwd, ["config", "user.name"], { allowFail: true });
  return result.stdout.trim() || "local";
}
async function shortLogSubject(cwd, rev = "HEAD") {
  return gitText(cwd, ["log", "-1", "--format=%s", rev]);
}
var import_node_fs, import_promises, import_node_path2;
var init_worktrees = __esm({
  "packages/core/src/worktrees.ts"() {
    "use strict";
    import_node_fs = require("node:fs");
    import_promises = require("node:fs/promises");
    import_node_path2 = __toESM(require("node:path"), 1);
    init_git();
  }
});

// packages/core/src/store.ts
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
var import_promises2, import_node_path3;
var init_store = __esm({
  "packages/core/src/store.ts"() {
    "use strict";
    import_promises2 = require("node:fs/promises");
    import_node_path3 = __toESM(require("node:path"), 1);
    init_git();
  }
});

// packages/core/src/watch.ts
function watchFile(dir) {
  return import_node_path4.default.join(dir, "watch.json");
}
function derive(inbox, queue, updatedAt) {
  const halted = inbox.halted && queue.halted;
  const reason = halted ? inbox.reason === queue.reason ? inbox.reason : inbox.reason ?? queue.reason : null;
  const exportId = inbox.exportId ?? queue.exportId;
  return { halted, reason, exportId, inbox, queue, updatedAt };
}
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
function parseWatchRaw(raw) {
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
}
async function getRepoWatch(cwd) {
  const root = await requireGitRoot(cwd);
  try {
    const raw = await (0, import_promises3.readFile)(watchFile(await consoleDir(root)), "utf8");
    return parseWatchRaw(raw);
  } catch {
    return idle();
  }
}
async function mutateWatch(cwd, fn) {
  const root = await requireGitRoot(cwd);
  const file = watchFile(await consoleDir(root));
  return withFileLock(file, async () => {
    let current = idle();
    try {
      current = parseWatchRaw(await (0, import_promises3.readFile)(file, "utf8"));
    } catch {
    }
    const next = fn(current);
    await writeJsonFile(file, next);
    return next;
  });
}
async function haltWatch(cwd, reason, exportId = null) {
  const lane = { halted: true, reason, exportId };
  return mutateWatch(cwd, () => derive(lane, { ...lane }, (/* @__PURE__ */ new Date()).toISOString()));
}
async function haltWatchRole(cwd, role, reason = "stop") {
  const lane = { halted: true, reason, exportId: null };
  return mutateWatch(cwd, (current) => {
    const inbox = role === "inbox" ? lane : current.inbox;
    const queue = role === "queue" ? lane : current.queue;
    return derive(inbox, queue, (/* @__PURE__ */ new Date()).toISOString());
  });
}
async function resumeWatchRole(cwd, role) {
  return mutateWatch(cwd, (current) => {
    const inbox = role === "inbox" ? idleLane() : current.inbox;
    const queue = role === "queue" ? idleLane() : current.queue;
    return derive(inbox, queue, (/* @__PURE__ */ new Date()).toISOString());
  });
}
async function resumeWatch(cwd) {
  return mutateWatch(cwd, () => derive(idleLane(), idleLane(), (/* @__PURE__ */ new Date()).toISOString()));
}
var import_promises3, import_node_path4, idleLane, idle;
var init_watch = __esm({
  "packages/core/src/watch.ts"() {
    "use strict";
    import_promises3 = require("node:fs/promises");
    import_node_path4 = __toESM(require("node:path"), 1);
    init_git();
    init_store();
    idleLane = () => ({
      halted: false,
      reason: null,
      exportId: null
    });
    idle = () => derive(idleLane(), idleLane(), (/* @__PURE__ */ new Date(0)).toISOString());
  }
});

// packages/core/src/learnings.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId(prefix) {
  return `${prefix}-${(0, import_node_crypto.randomBytes)(4).toString("hex")}`;
}
async function learningsFile(cwd) {
  const dir = await consoleDir(cwd);
  return import_node_path5.default.join(dir, "learnings.json");
}
async function readLearnings(cwd) {
  const file = await learningsFile(cwd);
  try {
    const raw = await (0, import_promises4.readFile)(file, "utf8");
    const store = parseJsonObject(raw);
    return {
      learnings: store.learnings ?? [],
      version: store.version ?? 1
    };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") {
      return { learnings: [], version: 1 };
    }
    throw err;
  }
}
async function writeLearnings(cwd, store) {
  const file = await learningsFile(cwd);
  await writeJsonFile(file, store);
}
async function extractLearningsFromResolvedComments(pr, comments) {
  const learnings = [];
  const now = nowIso();
  for (const comment of comments) {
    if (!isFindingComment(comment)) continue;
    if (comment.status !== "resolved") continue;
    if (comment.role !== "reviewer" && comment.role !== "human") continue;
    const pattern = extractPattern(comment.body);
    const guidance = extractGuidance(comment.body);
    if (!pattern || !guidance) continue;
    learnings.push({
      id: newId("learn"),
      pattern,
      guidance,
      sourceCommentId: comment.id,
      sourcePrId: pr.id,
      createdAt: comment.createdAt,
      learnedAt: now,
      disabled: false,
      path: comment.path,
      category: inferCategory(comment)
    });
  }
  return learnings;
}
function extractPattern(body) {
  const patternMatch = body.match(/pattern[:\s]+(.+?)(?:\n|$)/i) || body.match(/issue[:\s]+(.+?)(?:\n|$)/i) || body.match(/problem[:\s]+(.+?)(?:\n|$)/i);
  if (patternMatch) return patternMatch[1].trim();
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    return lines[0].trim().slice(0, 200);
  }
  return null;
}
function extractGuidance(body) {
  const guidanceMatch = body.match(/(?:fix|solution|should|must|instead)[:\s]+(.+?)(?:\n\n|$)/is) || body.match(/guidance[:\s]+(.+?)(?:\n\n|$)/is);
  if (guidanceMatch) return guidanceMatch[1].trim();
  return body.trim().slice(0, 500);
}
function inferCategory(comment) {
  const body = comment.body.toLowerCase();
  if (body.includes("test")) return "testing";
  if (body.includes("type") || body.includes("interface")) return "types";
  if (body.includes("style") || body.includes("format")) return "style";
  if (body.includes("security")) return "security";
  if (body.includes("performance")) return "performance";
  if (body.includes("error") || body.includes("exception")) return "error-handling";
  if (comment.path) {
    if (comment.path.endsWith(".test.ts") || comment.path.endsWith(".spec.ts")) return "testing";
    if (comment.path.endsWith(".md")) return "documentation";
  }
  return void 0;
}
async function addLearnings(cwd, learnings) {
  if (learnings.length === 0) return;
  const store = await readLearnings(cwd);
  store.learnings.push(...learnings);
  await writeLearnings(cwd, store);
}
async function listLearnings(cwd, options = {}) {
  const store = await readLearnings(cwd);
  let learnings = store.learnings;
  if (options.disabled !== void 0) {
    learnings = learnings.filter((l) => l.disabled === options.disabled);
  }
  if (options.category) {
    learnings = learnings.filter((l) => l.category === options.category);
  }
  return learnings.sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
}
async function getLearning(cwd, id) {
  const store = await readLearnings(cwd);
  return store.learnings.find((l) => l.id === id || l.id.startsWith(id)) ?? null;
}
async function disableLearning(cwd, id) {
  const store = await readLearnings(cwd);
  const learning = store.learnings.find((l) => l.id === id || l.id.startsWith(id));
  if (!learning) throw new Error(`Learning not found: ${id}`);
  learning.disabled = true;
  await writeLearnings(cwd, store);
  return learning;
}
async function enableLearning(cwd, id) {
  const store = await readLearnings(cwd);
  const learning = store.learnings.find((l) => l.id === id || l.id.startsWith(id));
  if (!learning) throw new Error(`Learning not found: ${id}`);
  learning.disabled = false;
  await writeLearnings(cwd, store);
  return learning;
}
async function deleteLearning(cwd, id) {
  const store = await readLearnings(cwd);
  const index = store.learnings.findIndex((l) => l.id === id || l.id.startsWith(id));
  if (index === -1) throw new Error(`Learning not found: ${id}`);
  const learning = store.learnings[index];
  store.learnings.splice(index, 1);
  await writeLearnings(cwd, store);
  return { id: learning.id, deleted: true };
}
async function runPreflight(cwd, pr) {
  const learnings = await listLearnings(cwd, { disabled: false });
  const issues = [];
  const diff = await getLocalPrDiff(cwd, pr.id, { maxBytes: 5e5 });
  for (const learning of learnings) {
    const patternLower = learning.pattern.toLowerCase();
    const titleLower = pr.title.toLowerCase();
    const bodyLower = pr.body.toLowerCase();
    const diffLower = diff.toLowerCase();
    if (titleLower.includes(patternLower)) {
      issues.push({
        learningId: learning.id,
        pattern: learning.pattern,
        guidance: learning.guidance,
        matchedIn: "title"
      });
      continue;
    }
    if (bodyLower.includes(patternLower)) {
      issues.push({
        learningId: learning.id,
        pattern: learning.pattern,
        guidance: learning.guidance,
        matchedIn: "body"
      });
      continue;
    }
    if (diffLower.includes(patternLower)) {
      issues.push({
        learningId: learning.id,
        pattern: learning.pattern,
        guidance: learning.guidance,
        matchedIn: "diff",
        path: learning.path
      });
    }
  }
  return {
    passed: issues.length === 0,
    issues
  };
}
var import_node_crypto, import_promises4, import_node_path5;
var init_learnings = __esm({
  "packages/core/src/learnings.ts"() {
    "use strict";
    import_node_crypto = require("node:crypto");
    import_promises4 = require("node:fs/promises");
    import_node_path5 = __toESM(require("node:path"), 1);
    init_store();
    init_prs();
    init_prs();
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
var github_ops_exports = {};
__export(github_ops_exports, {
  activeGhLogin: () => activeGhLogin,
  bindRepoGithub: () => bindRepoGithub,
  ensureRepoGithub: () => ensureRepoGithub,
  getRepoGithubBind: () => getRepoGithubBind,
  listGhAccounts: () => listGhAccounts,
  runGh: () => runGh,
  switchGhUser: () => switchGhUser
});
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
function runGh(args, options = {}) {
  return gh(args, options);
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
  return import_node_path6.default.join(dir, "github.json");
}
async function getRepoGithubBind(cwd) {
  const root = await findGitRoot(cwd);
  if (!root) return null;
  try {
    const raw = await (0, import_promises5.readFile)(bindFile(await consoleDir(root)), "utf8");
    const parsed = parseJsonObject(raw);
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
  await (0, import_promises5.mkdir)(dir, { recursive: true });
  await writeJsonFile(bindFile(dir), bind);
  return bind;
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
var import_node_child_process2, import_promises5, import_node_path6;
var init_github_ops = __esm({
  "packages/core/src/github-ops.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_promises5 = require("node:fs/promises");
    import_node_path6 = __toESM(require("node:path"), 1);
    init_git();
    init_store();
    init_github();
  }
});

// packages/core/src/prs.ts
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId2(prefix) {
  return `${prefix}-${(0, import_node_crypto2.randomBytes)(4).toString("hex")}`;
}
async function writePr(cwd, pr) {
  const dir = await prsDir(cwd);
  await writeJsonFile(prFile(dir, pr.id), pr);
  await git(cwd, ["update-ref", `refs/local-pr/${pr.id}/head`, pr.headSha]);
  await git(cwd, ["update-ref", `refs/local-pr/${pr.id}/base`, pr.baseSha]);
  const note = JSON.stringify({
    id: pr.id,
    title: pr.title,
    status: pr.status,
    headRef: pr.headRef,
    baseRef: pr.baseRef
  });
  await git(cwd, ["notes", "--ref=local-pr", "add", "-f", "-m", note, pr.headSha], {
    allowFail: true
  });
}
async function readPrFile(file) {
  const pr = parseJsonObject(await (0, import_promises6.readFile)(file, "utf8"));
  pr.source = pr.source ?? null;
  pr.reviewRequestedSha = pr.reviewRequestedSha ?? null;
  pr.reviewerNotifiedSha = pr.reviewerNotifiedSha ?? null;
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
  pr.updatedAt = nowIso2();
}
function isArchivedPr(pr) {
  return pr.status === "approved";
}
function normalizeLocalPrSearchFields(fields) {
  if (!fields?.length) return new Set(ALL_SEARCH_FIELDS);
  const out = /* @__PURE__ */ new Set();
  for (const f of fields) {
    if (ALL_SEARCH_FIELDS.includes(f)) out.add(f);
  }
  return out.size ? out : new Set(ALL_SEARCH_FIELDS);
}
function localPrMatchesSearch(pr, query, options = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const fields = normalizeLocalPrSearchFields(options.fields ? [...options.fields] : void 0);
  if (fields.has("title") && pr.title.toLowerCase().includes(needle)) return true;
  if (fields.has("body") && pr.body.toLowerCase().includes(needle)) return true;
  if (fields.has("comment")) {
    for (const c of pr.comments ?? []) {
      if (c.body.toLowerCase().includes(needle)) return true;
    }
  }
  if (fields.has("file")) {
    for (const c of pr.comments ?? []) {
      if (c.path?.toLowerCase().includes(needle)) return true;
    }
    for (const file of options.files ?? []) {
      if (file.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}
async function changedFilePathsForPr(cwd, pr) {
  const range = `${pr.baseSha}...${pr.headRef}`;
  const primary = await git(cwd, ["diff", "--name-only", range], { allowFail: true });
  const stdout = primary.code === 0 && primary.stdout.trim() ? primary.stdout : (await git(cwd, ["diff", "--name-only", `${pr.baseSha}...${pr.headSha}`], {
    allowFail: true
  })).stdout;
  if (!stdout.trim()) return [];
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}
async function listLocalPrs(cwd, options = {}) {
  await requireGitRoot(cwd);
  const dir = await prsDir(cwd);
  const names = await (0, import_promises6.readdir)(dir);
  const prs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await (0, import_promises6.readFile)(import_node_path7.default.join(dir, name), "utf8");
    let pr;
    try {
      pr = parseJsonObject(raw);
    } catch {
      continue;
    }
    pr.source = pr.source ?? null;
    pr.reviewRequestedSha = pr.reviewRequestedSha ?? null;
    pr.reviewerNotifiedSha = pr.reviewerNotifiedSha ?? null;
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    prs.push(pr);
  }
  prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const trees = await listWorktrees(cwd);
  for (const pr of prs) {
    pr.worktreePath = worktreeForLoop(trees, pr);
  }
  const search = options.search?.trim() ?? "";
  if (!search) return prs;
  const fields = normalizeLocalPrSearchFields(options.in);
  const needFiles = fields.has("file");
  const matched = [];
  for (const pr of prs) {
    if (localPrMatchesSearch(pr, search, {
      fields,
      files: needFiles ? [] : void 0
    })) {
      matched.push(pr);
      continue;
    }
    if (!needFiles) continue;
    const files = await changedFilePathsForPr(cwd, pr);
    if (localPrMatchesSearch(pr, search, { fields, files })) {
      matched.push(pr);
    }
  }
  return matched;
}
async function getLocalPr(cwd, id) {
  const prs = await listLocalPrs(cwd);
  const pr = prs.find((p) => p.id === id || p.id.startsWith(id));
  if (!pr) throw new Error(`Local PR not found: ${id}`);
  return pr;
}
async function resumeWatchForNextLoop(cwd) {
  const watch = await getRepoWatch(cwd);
  for (const role of ["inbox", "queue"]) {
    const lane = watch[role];
    if (!lane.halted || lane.reason !== "export") continue;
    if (lane.exportId) {
      try {
        const exported = await getLocalPr(cwd, lane.exportId);
        if (!isArchivedPr(exported)) continue;
      } catch (err) {
        if (!(err instanceof Error) || !err.message.startsWith("Local PR not found:")) throw err;
      }
    }
    await resumeWatchRole(cwd, role);
  }
}
async function createLocalPr(cwd, input = {}) {
  const root = await requireGitRoot(cwd);
  const id = newId2("lp");
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
  const createdAt = nowIso2();
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
    reviewRequestedSha: null,
    reviewerNotifiedSha: null
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
async function updateLocalPr(cwd, id, patch) {
  return withPrLock(cwd, id, (pr) => {
    if (patch.title !== void 0) {
      const title = patch.title.trim();
      if (!title) throw new Error("Title is empty");
      pr.title = title;
    }
    if (patch.body !== void 0) {
      pr.body = patch.body.trim();
    }
    pr.updatedAt = nowIso2();
  });
}
async function setLocalPrStatus(cwd, id, status, options = {}) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr) && status !== "approved") {
      throw new Error(
        `Loop ${pr.id} is archived. Start a new loop on a feature branch instead of reopening it.`
      );
    }
    if (status === "ready" && !options.skipPreflight) {
      const preflight = await runPreflight(cwd, pr);
      if (!preflight.passed) {
        const summary = preflight.issues.map(
          (issue) => `- [${issue.learningId}] Pattern: "${issue.pattern}" (matched in ${issue.matchedIn})
  Guidance: ${issue.guidance}`
        ).join("\n");
        throw new Error(
          `Preflight failed \u2014 ${preflight.issues.length} learned pattern(s) detected:

${summary}

Address these patterns or disable the learnings, then try ready again. Use skipPreflight=true to bypass.`
        );
      }
    }
    pr.status = status;
    if (status === "ready") await armReviewRequest(cwd, pr);
    pr.updatedAt = nowIso2();
  });
}
function isReviewRequestBody(body) {
  return /^review requested\.?$/i.test(body.trim());
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
function addressedReviewComments(pr) {
  return (pr.comments ?? []).map(normalizeComment).filter((c) => isFindingComment(c) && c.status === "addressed");
}
function commentThreads(comments) {
  const list = (comments ?? []).map(normalizeComment);
  const ids = new Set(list.map((c) => c.id));
  const assigned = /* @__PURE__ */ new Set();
  const repliesByParent = /* @__PURE__ */ new Map();
  for (const c of list) {
    if (c.replyTo && ids.has(c.replyTo)) {
      const bucket = repliesByParent.get(c.replyTo) ?? [];
      bucket.push(c);
      repliesByParent.set(c.replyTo, bucket);
      assigned.add(c.id);
    }
  }
  const threads = [];
  let lastFinding2;
  for (const c of list) {
    if (assigned.has(c.id)) continue;
    if (c.role === "agent" && !isReviewRequestBody(c.body) && lastFinding2) {
      lastFinding2.replies.push(c);
      continue;
    }
    const thread = { root: c, replies: repliesByParent.get(c.id) ?? [] };
    threads.push(thread);
    if (isFindingComment(c)) lastFinding2 = thread;
  }
  return threads;
}
function maybePromoteToReviewed(pr) {
  if (pr.status !== "changes_requested") return;
  const open2 = pendingReviewComments(pr);
  const addressed = addressedReviewComments(pr);
  if (open2.length > 0 || addressed.length > 0) return;
  pr.status = "reviewed";
}
async function armReviewRequest(cwd, pr) {
  await applyHeadRefresh(cwd, pr);
  pr.reviewRequestedSha = pr.headSha;
  pr.reviewerNotifiedSha = null;
}
async function maybeHandoffToReviewer(cwd, pr, now, author) {
  if (isArchivedPr(pr)) return;
  if (pr.status !== "changes_requested") return;
  if (pendingReviewComments(pr).length > 0) return;
  await armReviewRequest(cwd, pr);
  pr.status = "ready";
  pr.comments.push({
    id: newId2("c"),
    body: "Review requested.",
    createdAt: now,
    author,
    role: "agent",
    status: "resolved"
  });
  pr.updatedAt = now;
}
function lastFinding(pr) {
  const findings = (pr.comments ?? []).map(normalizeComment).filter(isFindingComment);
  return findings[findings.length - 1];
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
async function addLocalPrComment(cwd, id, body, options = {}) {
  const text = body.trim();
  if (!text) throw new Error("Comment body is empty");
  const role = options.role ?? "human";
  if (!COMMENT_ROLES.includes(role)) {
    throw new Error(`Invalid comment role: ${role}`);
  }
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject(await (0, import_promises6.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const comment = {
      id: newId2("c"),
      body: text,
      createdAt: nowIso2(),
      author: options.author?.trim() || await userName(cwd),
      role,
      status: role === "agent" ? "resolved" : "open"
    };
    const loc = options.path?.trim();
    if (loc) comment.path = loc.replace(/\\/g, "/");
    if (options.line && options.line > 0) comment.line = Math.floor(options.line);
    if (options.side === "left" || options.side === "right") comment.side = options.side;
    const replyTo = options.replyTo?.trim();
    if (replyTo) {
      const target = pr.comments.find((c) => c.id === replyTo || c.id.startsWith(replyTo));
      if (!target) throw new Error(`Comment not found: ${replyTo}`);
      comment.replyTo = target.id;
      comment.status = "resolved";
    } else if (role === "agent" && !isReviewRequestBody(text)) {
      const parent = lastFinding(pr);
      if (parent) comment.replyTo = parent.id;
    }
    pr.comments.push(comment);
    if (!isArchivedPr(pr) && comment.status === "open") {
      if (role === "human" || role === "reviewer" && pr.status === "reviewed") {
        pr.status = "changes_requested";
      }
    }
    pr.updatedAt = comment.createdAt;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}
async function editLocalPrComment(cwd, id, commentId, body) {
  const text = body.trim();
  if (!text) throw new Error("Comment body is empty");
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr)) throw new Error(`Loop ${pr.id} is archived.`);
    const target = pr.comments.find((c) => c.id === needle || c.id.startsWith(needle));
    if (!target) throw new Error(`Comment not found: ${commentId}`);
    if (!isFindingComment(target) || target.status !== "open") {
      throw new Error("Only open findings can be edited");
    }
    target.body = text;
    pr.updatedAt = nowIso2();
  });
}
async function deleteLocalPrComment(cwd, id, commentId) {
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr)) throw new Error(`Loop ${pr.id} is archived.`);
    const target = pr.comments.find((c) => c.id === needle || c.id.startsWith(needle));
    if (!target) throw new Error(`Comment not found: ${commentId}`);
    if (!isFindingComment(target) || target.status !== "open") {
      throw new Error("Only open findings can be deleted");
    }
    const drop = /* @__PURE__ */ new Set([target.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of pr.comments) {
        if (c.replyTo && drop.has(c.replyTo) && !drop.has(c.id)) {
          drop.add(c.id);
          grew = true;
        }
      }
    }
    pr.comments = pr.comments.filter((c) => !drop.has(c.id));
    pr.updatedAt = nowIso2();
  });
}
async function addressLocalPrComment(cwd, id, commentId, body, options = {}) {
  const text = body.trim();
  if (!text) throw new Error("Address comment is empty");
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject(await (0, import_promises6.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const target = pr.comments.find((c) => c.id === needle || c.id.startsWith(needle));
    if (!target) throw new Error(`Comment not found: ${commentId}`);
    if (!isFindingComment(target)) {
      throw new Error("Only human or reviewer findings can be addressed");
    }
    if (target.status !== "open") {
      throw new Error(`Comment ${target.id} is ${target.status}, not open`);
    }
    const now = nowIso2();
    const author = options.author?.trim() || await userName(cwd);
    target.status = "addressed";
    pr.comments.push({
      id: newId2("c"),
      body: text,
      createdAt: now,
      author,
      role: "agent",
      status: "resolved",
      replyTo: target.id
    });
    pr.updatedAt = now;
    await maybeHandoffToReviewer(cwd, pr, now, author);
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}
async function resolveLocalPrComment(cwd, id, commentId, body, options = {}) {
  const text = body.trim();
  if (!text) throw new Error("Resolution comment is empty");
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  const role = options.role === "human" ? "human" : "reviewer";
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject(await (0, import_promises6.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const target = pr.comments.find((c) => c.id === needle || c.id.startsWith(needle));
    if (!target) throw new Error(`Comment not found: ${commentId}`);
    if (!isFindingComment(target)) {
      throw new Error("Only human or reviewer findings can be resolved");
    }
    if (target.status === "resolved") {
      throw new Error(`Comment ${target.id} is already resolved`);
    }
    if (target.status === "open" && role !== "human") {
      throw new Error(
        `Comment ${target.id} is still open. The implementor must address_comment it before the reviewer resolves it.`
      );
    }
    const now = nowIso2();
    const author = options.author?.trim() || await userName(cwd);
    target.status = "resolved";
    target.resolvedAt = now;
    target.resolvedBy = author;
    pr.comments.push({
      id: newId2("c"),
      body: text,
      createdAt: now,
      author,
      role,
      status: "resolved",
      replyTo: target.id
    });
    pr.updatedAt = now;
    maybePromoteToReviewed(pr);
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}
async function completeLocalPrReview(cwd, id, options = {}) {
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject(await (0, import_promises6.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const reviewedAgainstSha = pr.reviewRequestedSha ?? null;
    await applyHeadRefresh(cwd, pr);
    const headDrift = Boolean(reviewedAgainstSha && reviewedAgainstSha !== pr.headSha);
    if (headDrift && !options.allowDrift) {
      throw new Error(
        `HEAD moved since Review requested (${reviewedAgainstSha?.slice(0, 8)} \u2192 ${pr.headSha.slice(0, 8)}). Re-diff and file any new findings while status is still ready, then complete-review again. Use --force / allowDrift only to finalize on purpose.`
      );
    }
    const open2 = pendingReviewComments(pr);
    const now = nowIso2();
    const author = options.author?.trim() || await userName(cwd);
    const resolvedComments = [];
    for (const comment of pr.comments) {
      if (isFindingComment(comment) && comment.status === "addressed") {
        comment.status = "resolved";
        comment.resolvedAt = now;
        comment.resolvedBy = author;
        resolvedComments.push(comment);
      }
    }
    const learnings = await extractLearningsFromResolvedComments(pr, resolvedComments);
    if (learnings.length > 0) {
      await addLearnings(cwd, learnings);
    }
    const handedToImplementor = open2.length > 0;
    pr.comments.push({
      id: newId2("c"),
      body: (options.body?.trim() || (handedToImplementor ? "Review complete. Findings are ready for the implementor." : "Review complete. Ready for human review.")).trim(),
      createdAt: now,
      author,
      role: "reviewer",
      status: "resolved"
    });
    if (!isArchivedPr(pr)) {
      pr.status = handedToImplementor ? "changes_requested" : "reviewed";
    }
    pr.updatedAt = now;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return { ...pr, headDrift, reviewedAgainstSha };
  });
}
async function getLocalPrDiff(cwd, id, options = {}) {
  const pr = await getLocalPr(cwd, id);
  const args = options.stat ? ["diff", "--stat", `${pr.baseSha}...${pr.headSha}`] : ["diff", `${pr.baseSha}...${pr.headSha}`];
  if (options.paths?.length) {
    args.push("--", ...options.paths);
  }
  const { stdout } = await git(cwd, args);
  const max = options.maxBytes ?? 2e5;
  if (stdout.length > max) {
    return `${stdout.slice(0, max)}

... truncated (${stdout.length} bytes) ...`;
  }
  return stdout;
}
async function deleteLocalPr(cwd, id) {
  const pr = await getLocalPr(cwd, id);
  await releaseArchivedLoop(cwd, pr);
  const dir = await prsDir(cwd);
  const file = prFile(dir, pr.id);
  await withFileLock(file, async () => {
    await (0, import_promises6.unlink)(file).catch(() => void 0);
  });
  await git(cwd, ["update-ref", "-d", `refs/local-pr/${pr.id}/head`], { allowFail: true });
  await git(cwd, ["update-ref", "-d", `refs/local-pr/${pr.id}/base`], { allowFail: true });
  return { id: pr.id, deleted: true };
}
async function reopenLocalPr(cwd, id) {
  const updated = await withPrLock(cwd, id, async (pr) => {
    if (!isArchivedPr(pr)) {
      throw new Error(`Loop ${pr.id} is not archived; only approved loops can be reopened.`);
    }
    pr.status = "changes_requested";
    pr.reviewRequestedSha = null;
    pr.reviewerNotifiedSha = null;
    await applyHeadRefresh(cwd, pr);
    pr.updatedAt = nowIso2();
  });
  updated.worktreePath = await ensureWorktreeForLoop(cwd, updated, {
    staleLoopIds: (await listLocalPrs(cwd)).filter((other) => other.id !== updated.id && isArchivedPr(other)).map((other) => other.id),
    liveLoopIds: (await listLocalPrs(cwd)).filter((other) => !isArchivedPr(other)).map((other) => other.id)
  });
  return updated;
}
async function getLocalPrNameStatus(cwd, id) {
  const pr = await getLocalPr(cwd, id);
  const { stdout } = await git(cwd, ["diff", "--name-status", `${pr.baseSha}...${pr.headSha}`]);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [status, ...rest] = line.split("	");
    return { status, path: rest.join("	") };
  });
}
async function attachLocalPr(cwd, input) {
  const root = await requireGitRoot(cwd);
  const { runGh: runGh2 } = await Promise.resolve().then(() => (init_github_ops(), github_ops_exports));
  const source = input.source.trim();
  let headRef;
  let baseRef;
  let title;
  let body;
  let headSha;
  let baseSha;
  const prNumberMatch = source.match(/^#?(\d+)$/) ?? source.match(/\/pull\/(\d+)/);
  if (prNumberMatch) {
    const prNumber = prNumberMatch[1];
    const result = await runGh2(
      ["pr", "view", prNumber, "--json", "title,body,headRefName,baseRefName,headRefOid,state"],
      { cwd }
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to fetch GitHub PR #${prNumber}: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
    const prData = JSON.parse(result.stdout);
    if (prData.state.toUpperCase() === "MERGED") {
      throw new Error(
        `GitHub PR #${prNumber} is already merged. Cannot attach merged PRs to new lanes.`
      );
    }
    headRef = prData.headRefName;
    baseRef = input.base ?? prData.baseRefName;
    title = input.title ?? prData.title;
    body = input.body ?? prData.body;
    const fetchResult = await git(root, ["fetch", "origin", headRef], { allowFail: true });
    if (fetchResult.code !== 0) {
      throw new Error(
        `Failed to fetch remote branch ${headRef}: ${fetchResult.stderr.trim() || "git fetch failed"}`
      );
    }
    const remoteRef = `origin/${headRef}`;
    const shaResult = await git(root, ["rev-parse", "--verify", remoteRef], { allowFail: true });
    if (shaResult.code !== 0) {
      throw new Error(`Cannot resolve remote branch: ${remoteRef}`);
    }
    headSha = shaResult.stdout.trim();
  } else {
    headRef = source.replace(/^origin\//, "");
    const fetchResult = await git(root, ["fetch", "origin", headRef], { allowFail: true });
    if (fetchResult.code !== 0) {
      throw new Error(
        `Failed to fetch remote branch ${headRef}: ${fetchResult.stderr.trim() || "git fetch failed"}`
      );
    }
    const remoteRef = `origin/${headRef}`;
    const shaResult = await git(root, ["rev-parse", "--verify", remoteRef], { allowFail: true });
    if (shaResult.code !== 0) {
      throw new Error(`Cannot resolve remote branch: ${remoteRef}`);
    }
    headSha = shaResult.stdout.trim();
    const detectedBase = input.base ?? await detectDefaultBase(cwd);
    baseRef = detectedBase.replace(/^origin\//, "");
    const prCheckResult = await runGh2(["pr", "view", headRef, "--json", "title,body,state"], {
      cwd
    });
    if (prCheckResult.code === 0) {
      try {
        const prData = JSON.parse(prCheckResult.stdout);
        if (prData.state.toUpperCase() === "MERGED") {
          throw new Error(
            `Branch ${headRef} has a merged GitHub PR. Cannot attach merged PRs to new lanes.`
          );
        }
        title = input.title ?? prData.title;
        body = input.body ?? prData.body;
      } catch (err) {
        if (err instanceof Error && err.message.includes("merged GitHub PR")) {
          throw err;
        }
        title = input.title ?? await shortLogSubject(cwd, headSha).catch(() => `Attached ${headRef}`);
        body = input.body ?? "";
      }
    } else {
      title = input.title ?? await shortLogSubject(cwd, headSha).catch(() => `Attached ${headRef}`);
      body = input.body ?? "";
    }
  }
  const baseResolved = await git(root, ["rev-parse", "--verify", baseRef], { allowFail: true });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  baseSha = baseResolved.stdout.trim();
  const existing = (await listLocalPrs(root)).find(
    (pr2) => pr2.headRef === headRef && !isArchivedPr(pr2)
  );
  if (existing) {
    throw new Error(
      `A lane for branch ${headRef} already exists (${existing.id}). Use update or refresh instead.`
    );
  }
  const id = newId2("lp");
  const createdAt = nowIso2();
  const pr = {
    id,
    title,
    body,
    status: "draft",
    headRef,
    baseRef,
    headSha,
    baseSha,
    worktreePath: null,
    comments: [],
    source: input.prSource ?? { kind: "cli" },
    createdAt,
    updatedAt: createdAt,
    reviewRequestedSha: null,
    reviewerNotifiedSha: null
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
var import_node_crypto2, import_promises6, import_node_path7, ALL_SEARCH_FIELDS;
var init_prs = __esm({
  "packages/core/src/prs.ts"() {
    "use strict";
    import_node_crypto2 = require("node:crypto");
    import_promises6 = require("node:fs/promises");
    import_node_path7 = __toESM(require("node:path"), 1);
    init_git();
    init_store();
    init_worktrees();
    init_types();
    init_watch();
    init_learnings();
    ALL_SEARCH_FIELDS = ["title", "body", "comment", "file"];
  }
});

// packages/core/src/watchActivity.ts
var init_watchActivity = __esm({
  "packages/core/src/watchActivity.ts"() {
    "use strict";
    init_prs();
  }
});

// packages/core/src/ci-cache.ts
async function ciCacheDir(cwd) {
  const common = await gitCommonDir(cwd);
  const dir = import_node_path8.default.join(common, "agent-console", "ci-cache");
  await (0, import_promises7.mkdir)(dir, { recursive: true });
  return dir;
}
async function ciCacheFile(cwd) {
  const dir = await ciCacheDir(cwd);
  return import_node_path8.default.join(dir, "cache.json");
}
async function loadCiCache(cwd) {
  try {
    const file = await ciCacheFile(cwd);
    const content = await (0, import_promises7.readFile)(file, "utf8");
    return JSON.parse(content);
  } catch {
    return { checks: {} };
  }
}
async function saveCiCache(cwd, cache) {
  const file = await ciCacheFile(cwd);
  await (0, import_promises7.writeFile)(file, JSON.stringify(cache, null, 2), "utf8");
}
async function computeTrackedFilesHash(cwd) {
  try {
    const { stdout } = await git(cwd, ["ls-tree", "-r", "HEAD"]);
    const hash = (0, import_node_crypto3.createHash)("sha256");
    hash.update(stdout);
    return hash.digest("hex");
  } catch {
    return null;
  }
}
async function computeScriptsHash(cwd) {
  try {
    const { stdout } = await git(cwd, ["show", "HEAD:package.json"]);
    const pkg = JSON.parse(stdout);
    const hash = (0, import_node_crypto3.createHash)("sha256");
    hash.update(JSON.stringify(pkg.scripts || {}));
    return hash.digest("hex");
  } catch {
    return null;
  }
}
async function computeCiInputHash(cwd) {
  const [filesHash, scriptsHash] = await Promise.all([
    computeTrackedFilesHash(cwd),
    computeScriptsHash(cwd)
  ]);
  if (!filesHash || !scriptsHash) {
    return null;
  }
  const hash = (0, import_node_crypto3.createHash)("sha256");
  hash.update(filesHash);
  hash.update(scriptsHash);
  return hash.digest("hex");
}
async function getCachedResult(cwd, check) {
  const currentHash = await computeCiInputHash(cwd);
  if (!currentHash) {
    return null;
  }
  const cache = await loadCiCache(cwd);
  const entry = cache.checks[check];
  if (!entry) {
    return null;
  }
  if (entry.inputHash !== currentHash) {
    return null;
  }
  return entry;
}
async function recordCheckPass(cwd, check) {
  const inputHash = await computeCiInputHash(cwd);
  if (!inputHash) {
    return;
  }
  const cache = await loadCiCache(cwd);
  cache.checks[check] = {
    inputHash,
    passedAt: (/* @__PURE__ */ new Date()).toISOString(),
    check
  };
  await saveCiCache(cwd, cache);
}
var import_node_crypto3, import_promises7, import_node_path8;
var init_ci_cache = __esm({
  "packages/core/src/ci-cache.ts"() {
    "use strict";
    import_node_crypto3 = require("node:crypto");
    import_promises7 = require("node:fs/promises");
    import_node_path8 = __toESM(require("node:path"), 1);
    init_git();
  }
});

// packages/core/src/ci-runner.ts
async function getTrackedFiles(cwd) {
  try {
    const { stdout } = await execAsync("git ls-files --exclude-standard", { cwd });
    const files = stdout.trim().split("\n").filter(Boolean);
    const fs = await import("node:fs/promises");
    const path9 = await import("node:path");
    const validFiles = [];
    const skipFiles = /* @__PURE__ */ new Set([
      ".gitignore",
      ".prettierignore",
      ".eslintignore",
      ".dockerignore",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock"
    ]);
    const prettierExts = /* @__PURE__ */ new Set([
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".mjs",
      ".cjs",
      ".json",
      ".css",
      ".scss",
      ".less",
      ".html",
      ".md",
      ".yml",
      ".yaml",
      ".xml"
    ]);
    for (const file of files) {
      const basename = path9.basename(file);
      const ext = path9.extname(file).toLowerCase();
      if (skipFiles.has(basename)) {
        continue;
      }
      if (!prettierExts.has(ext)) {
        continue;
      }
      try {
        const fullPath = path9.join(cwd, file);
        const stats = await fs.stat(fullPath);
        if (stats.isFile()) {
          validFiles.push(file);
        }
      } catch {
      }
    }
    return validFiles;
  } catch {
    return [];
  }
}
async function checkFormatFromBlobs(cwd, files) {
  const failures = [];
  for (const file of files) {
    try {
      const command = `git show ":${file.replace(/"/g, '\\"')}" | pnpm exec prettier --stdin-filepath "${file.replace(/"/g, '\\"')}" --check`;
      await execAsync(command, { cwd });
    } catch {
      failures.push(file);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Prettier format check failed for ${failures.length} file(s): ${failures.slice(0, 5).join(", ")}${failures.length > 5 ? "..." : ""}`
    );
  }
}
async function runCiChecks(cwd, options = {}) {
  const checks = options.checks ?? ["format:check", "lint", "typecheck", "test", "build"];
  const timeout = options.timeout ?? 3e5;
  const skipCache = options.skipCache ?? false;
  const results = [];
  for (const check of checks) {
    if (!skipCache) {
      const cached = await getCachedResult(cwd, check);
      if (cached) {
        results.push({ name: check, passed: true });
        continue;
      }
    }
    try {
      const command = `pnpm ${check}`;
      if (check === "format:check") {
        const tracked = await getTrackedFiles(cwd);
        if (tracked.length > 0) {
          await checkFormatFromBlobs(cwd, tracked);
          results.push({ name: check, passed: true });
          await recordCheckPass(cwd, check);
          continue;
        }
      }
      await execAsync(command, { cwd, timeout });
      results.push({ name: check, passed: true });
      await recordCheckPass(cwd, check);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: check,
        passed: false,
        error: message.split("\n")[0] || `Check '${check}' failed`
      });
    }
  }
  return {
    allPassed: results.every((r) => r.passed),
    checks: results
  };
}
var import_node_child_process3, import_node_util, execAsync;
var init_ci_runner = __esm({
  "packages/core/src/ci-runner.ts"() {
    "use strict";
    import_node_child_process3 = require("node:child_process");
    import_node_util = require("node:util");
    init_ci_cache();
    execAsync = (0, import_node_util.promisify)(import_node_child_process3.exec);
  }
});

// packages/core/src/shepherd.ts
async function shepherdStatus(cwd, id, options = {}) {
  const reasons = [];
  try {
    const pr = await getLocalPr(cwd, id);
    if (!isArchivedPr(pr) && pr.status !== "reviewed" && pr.status !== "approved") {
      const pending = pendingReviewComments(pr);
      if (pending.length > 0) {
        reasons.push({
          check: "review",
          message: `Review incomplete: ${pending.length} open finding(s)`
        });
      } else if (pr.status === "draft") {
        reasons.push({
          check: "review",
          message: "Status is draft (not ready for review)"
        });
      } else if (pr.status === "ready") {
        reasons.push({
          check: "review",
          message: "Review not started (status is ready)"
        });
      } else if (pr.status === "changes_requested") {
        reasons.push({
          check: "review",
          message: "Changes requested (review not complete)"
        });
      }
    }
    const preflight = await runPreflight(cwd, pr);
    if (!preflight.passed) {
      for (const issue of preflight.issues) {
        reasons.push({
          check: "preflight",
          message: `Pattern blocked: ${issue.pattern} (matched in ${issue.matchedIn})`
        });
      }
    }
    if (!options.skipGithubCheck) {
      const ghState = await ensureRepoGithub(cwd);
      if (!ghState.login) {
        reasons.push({
          check: "github",
          message: "No GitHub account logged in (run: gh auth login)"
        });
      } else if (!ghState.bound) {
        reasons.push({
          check: "github",
          message: `Repo not bound to GitHub account (run: prgenie gh use ${ghState.login})`
        });
      }
    }
    if (!options.skipCiCheck) {
      const ciResult = await runCiChecks(cwd);
      if (!ciResult.allPassed) {
        for (const check of ciResult.checks) {
          if (!check.passed) {
            reasons.push({
              check: "ci",
              message: `CI check failed: ${check.name}${check.error ? ` \u2014 ${check.error}` : ""}`
            });
          }
        }
      }
    }
  } catch (err) {
    reasons.push({
      check: "review",
      message: `Failed to check shepherd status: ${err instanceof Error ? err.message : String(err)}`
    });
  }
  return {
    status: reasons.length === 0 ? "ready" : "blocked",
    reasons
  };
}
var init_shepherd = __esm({
  "packages/core/src/shepherd.ts"() {
    "use strict";
    init_prs();
    init_learnings();
    init_github_ops();
    init_ci_runner();
  }
});

// packages/core/src/export-validation.ts
var export_validation_exports = {};
__export(export_validation_exports, {
  validateExport: () => validateExport
});
async function validateExport(cwd, id, options = {}) {
  if (options.skipValidation) {
    return { ok: true, issues: [] };
  }
  const shepherd = await shepherdStatus(cwd, id, {});
  if (shepherd.status === "ready") {
    return { ok: true, issues: [] };
  }
  const issues = shepherd.reasons.map((reason) => {
    const prefix = reason.check === "review" ? "Review" : reason.check === "preflight" ? "Preflight" : reason.check === "github" ? "GitHub" : reason.check === "ci" ? "CI" : "Check";
    return `${prefix}: ${reason.message}`;
  });
  return { ok: false, issues };
}
var init_export_validation = __esm({
  "packages/core/src/export-validation.ts"() {
    "use strict";
    init_shepherd();
  }
});

// packages/core/src/index.ts
init_types();
init_git();
init_worktrees();
init_prs();
init_watch();
init_watchActivity();

// packages/core/src/doctor.ts
init_git();
init_github_ops();
init_prs();
init_watch();
init_worktrees();

// packages/core/src/export.ts
init_git();
init_github_ops();
init_prs();
init_worktrees();
init_watch();
function ghBase(ref) {
  return ref.replace(/^origin\//, "").replace(/^refs\/heads\//, "");
}
function githubPrViewArgs(headRef, options) {
  const args = ["pr", "view", localBaseRef(headRef), "--json", options.json];
  if (options.jq) args.push("-q", options.jq);
  return args;
}
async function githubPrStateForHead(cwd, headRef) {
  const result = await runGh(githubPrViewArgs(headRef, { json: "state" }), { cwd });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const state = parsed.state?.toUpperCase();
    if (state === "MERGED" || state === "OPEN" || state === "CLOSED") return state;
  } catch {
  }
  return null;
}
async function archiveLoopsMergedOnGithub(cwd, lookup = (head) => githubPrStateForHead(cwd, head)) {
  const ids = [];
  const prs = await listLocalPrs(cwd);
  for (const pr of prs) {
    if (isArchivedPr(pr)) continue;
    let state;
    try {
      state = await lookup(pr.headRef);
    } catch {
      continue;
    }
    if (state !== "MERGED") continue;
    await setLocalPrStatus(cwd, pr.id, "approved");
    const archived = await getLocalPr(cwd, pr.id);
    await releaseArchivedLoop(cwd, archived);
    ids.push(pr.id);
  }
  return ids;
}
function exportPushRefspec(pr) {
  return `${pr.headSha}:refs/heads/${pr.headRef}`;
}
async function exportLocalPr(cwd, id, options = {}) {
  const { validateExport: validateExport2 } = await Promise.resolve().then(() => (init_export_validation(), export_validation_exports));
  const validation = await validateExport2(cwd, id, options);
  if (!validation.ok) {
    throw new Error(
      `Export blocked. ${validation.issues.join(" ")}${options.skipValidation ? "" : " Use --skip-validation to override (not recommended)."}`
    );
  }
  const pr = await getLocalPr(cwd, id);
  const ghState = await ensureRepoGithub(cwd);
  if (!ghState.bound && !ghState.login) {
    throw new Error("No GitHub account. Run: gh auth login, then prgenie gh use <login>");
  }
  if (!ghState.bound) {
    throw new Error(
      `This repo is not bound to a GitHub login. Ask which account, then prgenie gh use <login> (active is ${ghState.login}).`
    );
  }
  await haltWatch(cwd, "export", pr.id);
  try {
    const push = await git(cwd, ["push", "-u", "origin", exportPushRefspec(pr)], {
      allowFail: true
    });
    if (push.code !== 0) {
      throw new Error(push.stderr.trim() || `git push failed for ${pr.headRef}`);
    }
    const existing = await runGh(githubPrViewArgs(pr.headRef, { json: "url", jq: ".url" }), {
      cwd
    });
    let url;
    let alreadyExisted = false;
    if (existing.code === 0 && existing.stdout.trim().startsWith("http")) {
      url = existing.stdout.trim();
      alreadyExisted = true;
    } else {
      const created = await runGh(
        [
          "pr",
          "create",
          "--title",
          pr.title,
          "--body",
          pr.body.trim() || pr.title,
          "--base",
          ghBase(pr.baseRef),
          "--head",
          pr.headRef
        ],
        { cwd }
      );
      if (created.code !== 0) {
        throw new Error(created.stderr.trim() || created.stdout.trim() || "gh pr create failed");
      }
      url = created.stdout.trim().split("\n").find((line) => /^https?:\/\//.test(line)) ?? created.stdout.trim();
      if (!url) throw new Error("gh pr create succeeded but returned no URL");
    }
    if (pr.status !== "approved") {
      await setLocalPrStatus(cwd, pr.id, "approved");
    }
    const archived = await getLocalPr(cwd, pr.id);
    const released = await releaseArchivedLoop(cwd, archived);
    return { url, id: pr.id, alreadyExisted, ...released };
  } catch (err) {
    await resumeWatch(cwd);
    throw err;
  }
}

// packages/core/src/index.ts
init_export_validation();

// packages/core/src/sessions.ts
var import_promises8 = require("node:fs/promises");
init_git();
init_store();
async function listSessions(cwd, options = {}) {
  const root = await findGitRoot(cwd);
  if (!root) return [];
  const file = await sessionsFile(root);
  let raw;
  try {
    raw = await (0, import_promises8.readFile)(file, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") return [];
    throw err;
  }
  const limitRaw = options.limit ?? 50;
  const limit = Math.min(1e3, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));
  const hook = typeof options.hook === "string" && options.hook ? options.hook : void 0;
  const sinceMs = typeof options.since === "string" && options.since ? Date.parse(options.since) : Number.NaN;
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed;
    if (hook && event.hook !== hook) continue;
    if (Number.isFinite(sinceMs)) {
      const atMs = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
      if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    }
    events.push(event);
  }
  events.sort((a, b) => {
    const aMs = typeof a.at === "string" ? Date.parse(a.at) : 0;
    const bMs = typeof b.at === "string" ? Date.parse(b.at) : 0;
    return bMs - aMs;
  });
  return events.slice(0, limit);
}

// packages/core/src/learning.ts
init_git();
init_prs();
function extractKeywords(text) {
  const stopWords = /* @__PURE__ */ new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "should",
    "could",
    "can",
    "may",
    "might",
    "must",
    "this",
    "that",
    "these",
    "those",
    "i",
    "you",
    "he",
    "she",
    "it",
    "we",
    "they",
    "what",
    "which",
    "who",
    "when",
    "where",
    "why",
    "how",
    "not",
    "no",
    "yes"
  ]);
  const normalized = text.toLowerCase().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter((w) => w.length > 2 && !stopWords.has(w));
  const keywords = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!stopWords.has(word) && word.length > 3) {
      keywords.push(word);
    }
    if (i < words.length - 1) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (bigram.length > 6) keywords.push(bigram);
    }
    if (i < words.length - 2) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (trigram.length > 10) keywords.push(trigram);
    }
  }
  return keywords;
}
function identifyPattern(text) {
  const lower = text.toLowerCase();
  const patterns = [
    { regex: /\b(missing|need[s]?|add|include)\s+test[s]?\b/i, label: "missing tests" },
    {
      regex: /\b(missing|need[s]?)\s+(error|exception)\s+handling\b/i,
      label: "missing error handling"
    },
    { regex: /\bnull\s+(check|pointer|reference)\b/i, label: "null safety" },
    { regex: /\b(type|typing)\s+(error|issue|problem)\b/i, label: "type issues" },
    { regex: /\b(typo|spelling|misspell)/i, label: "typos" },
    { regex: /\b(locali[zs]ation|locali[zs]e|hardcoded\s+string)/i, label: "localization" },
    { regex: /\b(duplicate|duplicated|repeated)\s+code\b/i, label: "code duplication" },
    {
      regex: /\b(extract|refactor|separate)\s+(method|function|component|class)\b/i,
      label: "refactoring needed"
    },
    { regex: /\b(const|constant)\s+(widget|component|class)\b/i, label: "const widget pattern" },
    { regex: /\b(performance|optimi[zs]e|slow|inefficient)\b/i, label: "performance" },
    { regex: /\b(security|vulnerability|unsafe)\b/i, label: "security" },
    { regex: /\b(documentation|document|comment|explain)\b/i, label: "documentation" },
    { regex: /\b(naming|name|rename)\b/i, label: "naming" },
    { regex: /\b(format|formatting|style)\b/i, label: "code style" },
    { regex: /\b(edge case|boundary|corner case)\b/i, label: "edge cases" }
  ];
  for (const { regex, label } of patterns) {
    if (regex.test(lower)) return label;
  }
  return null;
}
async function generateLearningDigest(cwd, options = {}) {
  const root = await findGitRoot(cwd);
  if (!root) {
    return {
      totalComments: 0,
      totalSessions: 0,
      topKeywords: [],
      topFiles: [],
      patterns: [],
      sessionHooks: []
    };
  }
  const sessionLimit = options.sessionLimit ?? 100;
  const sessions = await listSessions(root, { limit: sessionLimit, since: options.since });
  const prs = await listLocalPrs(root);
  const keywordCounts = /* @__PURE__ */ new Map();
  const fileCounts = /* @__PURE__ */ new Map();
  const patternCounts = /* @__PURE__ */ new Map();
  const sessionHookCounts = /* @__PURE__ */ new Map();
  let totalComments = 0;
  for (const pr of prs) {
    for (const comment of pr.comments ?? []) {
      if (comment.role !== "human" && comment.role !== "reviewer") continue;
      if (options.since) {
        const commentDate = new Date(comment.createdAt).getTime();
        const sinceDate = new Date(options.since).getTime();
        if (!Number.isFinite(commentDate)) continue;
        if (commentDate < sinceDate) continue;
      }
      totalComments++;
      const keywords = extractKeywords(comment.body);
      for (const keyword of keywords) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
      }
      if (comment.path) {
        fileCounts.set(comment.path, (fileCounts.get(comment.path) ?? 0) + 1);
      }
      const pattern = identifyPattern(comment.body);
      if (pattern) {
        const existing = patternCounts.get(pattern) ?? { count: 0, examples: [] };
        existing.count++;
        if (existing.examples.length < 3) {
          const example = comment.body.split("\n")[0].trim();
          if (example.length > 0 && example.length <= 100) {
            existing.examples.push(example);
          } else if (example.length > 100) {
            existing.examples.push(example.slice(0, 97) + "...");
          }
        }
        patternCounts.set(pattern, existing);
      }
    }
  }
  for (const session of sessions) {
    if (typeof session.hook === "string" && session.hook) {
      sessionHookCounts.set(session.hook, (sessionHookCounts.get(session.hook) ?? 0) + 1);
    }
  }
  const topKeywords = Array.from(keywordCounts.entries()).filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([keyword, count]) => ({ keyword, count }));
  const topFiles = Array.from(fileCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path9, count]) => ({ path: path9, count }));
  const patterns = Array.from(patternCounts.entries()).filter(([, data]) => data.count >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([pattern, data]) => ({
    pattern,
    examples: data.examples,
    count: data.count
  }));
  const sessionHooks = Array.from(sessionHookCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([hook, count]) => ({ hook, count }));
  return {
    totalComments,
    totalSessions: sessions.length,
    topKeywords,
    topFiles,
    patterns,
    sessionHooks
  };
}
function formatLearningDigest(summary) {
  const lines = [];
  lines.push("# PR Genie Learning Digest");
  lines.push("");
  lines.push(
    `Analyzed ${summary.totalComments} review comment(s) and ${summary.totalSessions} session(s).`
  );
  lines.push("");
  if (summary.patterns.length > 0) {
    lines.push("## What Keeps Getting Flagged");
    lines.push("");
    for (const { pattern, count, examples } of summary.patterns) {
      lines.push(`**${pattern}** \u2014 flagged ${count} time(s)`);
      if (examples.length > 0) {
        for (const example of examples) {
          lines.push(`  - "${example}"`);
        }
      }
      lines.push("");
    }
  }
  if (summary.topFiles.length > 0) {
    lines.push("## Most Commented Files");
    lines.push("");
    for (const { path: path9, count } of summary.topFiles) {
      lines.push(`- \`${path9}\` \u2014 ${count} comment(s)`);
    }
    lines.push("");
  }
  if (summary.topKeywords.length > 0) {
    lines.push("## Common Keywords");
    lines.push("");
    for (const { keyword, count } of summary.topKeywords.slice(0, 15)) {
      lines.push(`- ${keyword} (${count})`);
    }
    lines.push("");
  }
  if (summary.sessionHooks.length > 0) {
    lines.push("## Session Activity");
    lines.push("");
    for (const { hook, count } of summary.sessionHooks) {
      lines.push(`- ${hook}: ${count} event(s)`);
    }
    lines.push("");
  }
  if (summary.patterns.length === 0 && summary.topFiles.length === 0 && summary.topKeywords.length === 0) {
    lines.push(
      "No recurring patterns found. Either this is the first review or patterns haven't emerged yet."
    );
  }
  return lines.join("\n").trim();
}

// packages/core/src/index.ts
init_store();
init_github();
init_github_ops();
init_learnings();
init_shepherd();
init_ci_runner();
init_ci_cache();

// packages/cli/src/mcp-stdio.ts
function encodeMcpFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r
\r
`, "ascii");
  return Buffer.concat([header, body]);
}
function headerEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) return crlf + 4;
  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) return lf + 2;
  return -1;
}
function contentLengthOf(headers) {
  const match = headers.match(/^content-length:\s*(\d+)\s*$/im);
  if (!match) return null;
  return Number(match[1]);
}
function takeMcpMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length > 0) {
    const trimmedStart = rest.findIndex(
      (b) => b !== 32 && b !== 9 && b !== 13 && b !== 10
    );
    if (trimmedStart > 0) rest = rest.subarray(trimmedStart);
    if (rest.length === 0) break;
    const asStart = rest.toString("ascii", 0, Math.min(rest.length, 64));
    if (/^content-length:/i.test(asStart) || /^content-type:/i.test(asStart)) {
      const end = headerEnd(rest);
      if (end === -1) break;
      const headers = rest.subarray(0, end).toString("ascii");
      const length = contentLengthOf(headers);
      if (length === null) {
        rest = rest.subarray(end);
        continue;
      }
      if (rest.length < end + length) break;
      const body = rest.subarray(end, end + length);
      rest = rest.subarray(end + length);
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
      }
      continue;
    }
    if (rest[0] === 123) {
      const nl2 = rest.indexOf(10);
      if (nl2 === -1) break;
      const line = rest.subarray(0, nl2).toString("utf8").replace(/\r$/, "").trim();
      rest = rest.subarray(nl2 + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
      }
      continue;
    }
    const nl = rest.indexOf(10);
    if (nl === -1) break;
    rest = rest.subarray(nl + 1);
  }
  return { messages, rest };
}

// packages/cli/src/mcp.ts
function writeMessage(msg) {
  process.stdout.write(encodeMcpFrame(msg));
}
function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}
function notify(method, params) {
  writeMessage(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
}
function fail(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
function withCommentViews(pr) {
  return {
    ...pr,
    pendingComments: pendingReviewComments(pr),
    addressedComments: addressedReviewComments(pr),
    threads: commentThreads(pr.comments)
  };
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
    case "list_sessions":
      return listSessions(cwd, {
        limit: typeof args.limit === "number" ? args.limit : void 0,
        hook: typeof args.hook === "string" ? args.hook : void 0,
        since: typeof args.since === "string" ? args.since : void 0
      });
    case "learning_digest": {
      const summary = await generateLearningDigest(cwd, {
        sessionLimit: typeof args.sessionLimit === "number" ? args.sessionLimit : void 0,
        since: typeof args.since === "string" ? args.since : void 0
      });
      return {
        summary,
        formatted: formatLearningDigest(summary)
      };
    }
    case "list_worktrees":
      return listWorktrees(cwd);
    case "list_local_prs": {
      await archiveLoopsMergedOnGithub(cwd).catch(() => []);
      const search = typeof args.search === "string" ? args.search : typeof args.query === "string" ? args.query : void 0;
      const inArg = args.in;
      const inFields = Array.isArray(inArg) ? inArg.filter((f) => f === "title" || f === "body" || f === "comment" || f === "file") : typeof inArg === "string" ? inArg.split(",").map((s) => s.trim()).filter((f) => f === "title" || f === "body" || f === "comment" || f === "file") : void 0;
      const prs = (await listLocalPrs(cwd, { search, in: inFields })).map(withCommentViews);
      const status = typeof args.status === "string" ? args.status : "";
      const inbox = args.inbox === true;
      const all = args.all === true;
      if (inbox) {
        const mine = await findLocalPrForCurrentWorktree(cwd);
        if (!mine || mine.status !== "changes_requested" || pendingReviewComments(mine).length === 0) {
          return [];
        }
        return [withCommentViews(mine)];
      }
      return prs.filter((pr) => {
        if (status && pr.status !== status) return false;
        if (!status && !all && isArchivedPr(pr)) return false;
        return true;
      });
    }
    case "create_local_pr":
      return createLocalPr(cwd, {
        title: typeof args.title === "string" ? args.title : void 0,
        body: typeof args.body === "string" ? args.body : void 0,
        base: typeof args.base === "string" ? args.base : void 0,
        head: typeof args.head === "string" ? args.head : void 0
      });
    case "attach_local_pr":
      return attachLocalPr(cwd, {
        source: String(args.source ?? ""),
        title: typeof args.title === "string" ? args.title : void 0,
        body: typeof args.body === "string" ? args.body : void 0,
        base: typeof args.base === "string" ? args.base : void 0
      });
    case "update_local_pr":
      return updateLocalPr(cwd, String(args.id ?? ""), {
        title: typeof args.title === "string" ? args.title : void 0,
        body: typeof args.body === "string" ? args.body : void 0
      });
    case "get_local_pr": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
      return withCommentViews(pr);
    }
    case "set_status":
      return setLocalPrStatus(cwd, String(args.id ?? ""), args.status, {
        skipPreflight: typeof args.skipPreflight === "boolean" ? args.skipPreflight : void 0
      });
    case "add_comment": {
      const role = typeof args.role === "string" ? args.role : void 0;
      const author = typeof args.author === "string" ? args.author : void 0;
      return addLocalPrComment(cwd, String(args.id ?? ""), String(args.body ?? ""), {
        role,
        author,
        path: typeof args.path === "string" ? args.path : void 0,
        line: typeof args.line === "number" ? args.line : void 0,
        side: args.side === "left" || args.side === "right" ? args.side : void 0,
        replyTo: typeof args.replyTo === "string" ? args.replyTo : void 0
      });
    }
    case "address_comment":
      return addressLocalPrComment(
        cwd,
        String(args.id ?? ""),
        String(args.commentId ?? ""),
        String(args.body ?? ""),
        { author: typeof args.author === "string" ? args.author : void 0 }
      );
    case "resolve_comment":
      return resolveLocalPrComment(
        cwd,
        String(args.id ?? ""),
        String(args.commentId ?? ""),
        String(args.body ?? ""),
        {
          author: typeof args.author === "string" ? args.author : void 0,
          role: args.role === "human" ? "human" : "reviewer"
        }
      );
    case "edit_comment":
      return editLocalPrComment(
        cwd,
        String(args.id ?? ""),
        String(args.commentId ?? ""),
        String(args.body ?? "")
      );
    case "delete_comment":
      return deleteLocalPrComment(cwd, String(args.id ?? ""), String(args.commentId ?? ""));
    case "complete_review":
      return completeLocalPrReview(cwd, String(args.id ?? ""), {
        author: typeof args.author === "string" ? args.author : void 0,
        body: typeof args.body === "string" ? args.body : void 0,
        allowDrift: args.allowDrift === true
      });
    case "get_diff": {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : void 0;
      return {
        files: await getLocalPrNameStatus(cwd, String(args.id ?? "")),
        diff: await getLocalPrDiff(cwd, String(args.id ?? ""), {
          maxBytes: 8e4,
          stat: args.stat === true,
          paths
        }),
        truncatedHint: "If diff ends with truncated, call get_diff with stat=true then again with paths for individual files."
      };
    }
    case "delete_local_pr":
      return deleteLocalPr(cwd, String(args.id ?? ""));
    case "reopen_local_pr":
      return reopenLocalPr(cwd, String(args.id ?? ""));
    case "watch_status":
      return getRepoWatch(cwd);
    case "watch_stop": {
      const role = args.role === "inbox" || args.role === "queue" ? args.role : void 0;
      return role ? haltWatchRole(cwd, role, "stop") : haltWatch(cwd, "stop");
    }
    case "watch_start": {
      const role = args.role === "inbox" || args.role === "queue" ? args.role : void 0;
      return role ? resumeWatchRole(cwd, role) : resumeWatch(cwd);
    }
    case "ensure_worktree": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
      const dest = await ensureWorktreeForLoop(cwd, pr, {
        staleLoopIds: (await listLocalPrs(cwd)).filter((p) => p.id !== pr.id && isArchivedPr(p)).map((p) => p.id),
        liveLoopIds: (await listLocalPrs(cwd)).filter((p) => !isArchivedPr(p)).map((p) => p.id)
      });
      return { ...pr, worktreePath: dest };
    }
    case "export_local_pr":
      return exportLocalPr(cwd, String(args.id ?? ""), {
        skipValidation: args.skipValidation === true
      });
    case "list_learnings":
      return listLearnings(cwd, {
        disabled: typeof args.disabled === "boolean" ? args.disabled : void 0,
        category: typeof args.category === "string" ? args.category : void 0
      });
    case "get_learning":
      return getLearning(cwd, String(args.id ?? ""));
    case "disable_learning":
      return disableLearning(cwd, String(args.id ?? ""));
    case "enable_learning":
      return enableLearning(cwd, String(args.id ?? ""));
    case "delete_learning":
      return deleteLearning(cwd, String(args.id ?? ""));
    case "run_preflight": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
      return runPreflight(cwd, pr);
    }
    case "shepherd_status":
      return shepherdStatus(cwd, String(args.id ?? ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
var tools = [
  {
    name: "list_sessions",
    description: "Read PR Genie session history from sessions.jsonl (newest first). Skips corrupt lines. Optional limit (default 50), hook filter, and since ISO timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        limit: { type: "number", description: "Max events to return (newest first). Default 50." },
        hook: { type: "string", description: "Exact hook name filter, e.g. subagentStop." },
        since: { type: "string", description: "Inclusive ISO lower bound on event.at." }
      }
    }
  },
  {
    name: "learning_digest",
    description: "Generate a learning digest from session history and PR comment patterns. Shows what keeps getting flagged in reviews: common issues, frequently commented files, recurring patterns, and session activity. Useful for understanding review trends and common mistakes.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        sessionLimit: {
          type: "number",
          description: "Max sessions to analyze (default 100)."
        },
        since: {
          type: "string",
          description: "Only analyze comments and sessions since this ISO timestamp."
        }
      }
    }
  },
  {
    name: "list_worktrees",
    description: "List git worktrees. PR Genie also ensures one worktree per loop.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "ensure_worktree",
    description: "Ensure this loop has a git worktree and return its path. Creates a sibling <repo>.loops/<id> checkout when the branch is not already checked out.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "list_local_prs",
    description: "List unpublished local pull requests. Approved (exported) loops are archived and hidden unless all=true or status=approved. status=ready is the reviewer queue (comments may still be accumulating). status=reviewed is waiting on the human. inbox=true is only this worktree's loop when it is changes_requested with open pendingComments. search/query matches title, body, comments, and changed file paths (case-insensitive substring). Optional in limits fields to title,body,comment,file.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "ready", "changes_requested", "reviewed", "approved"]
        },
        inbox: {
          type: "boolean",
          description: "Only this worktree's loop, and only if it is changes_requested with open pendingComments."
        },
        all: {
          type: "boolean",
          description: "Include archived (approved/exported) loops. Hidden by default."
        },
        search: {
          type: "string",
          description: "Case-insensitive substring across title, body, comments, and changed files."
        },
        query: {
          type: "string",
          description: "Alias for search."
        },
        in: {
          description: "Limit search fields: title, body, comment, file (array or comma-separated string)."
        }
      }
    }
  },
  {
    name: "create_local_pr",
    description: "Create a local PR (unpublished review loop) from the current branch or a named head. Always set body to a reviewer summary (why, what changed, how to test). Do not git push or gh pr create.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: {
          type: "string",
          description: "Loop summary for reviewers: why, what changed, how to test."
        },
        base: { type: "string" },
        head: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "attach_local_pr",
    description: "Attach an existing GitHub PR or remote branch into a new PR Genie lane. Fetches PR/branch metadata from GitHub and creates a local lane with the same gating (review + preflight + export shepherd). Accepts GitHub PR number (#123), PR URL, or branch name. The branch is fetched but not checked out until worktree creation. The lane starts as draft and follows the same review/export workflow as locally-created lanes. Do not use for merged PRs.",
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: {
          type: "string",
          description: "GitHub PR number (e.g., '123' or '#123'), PR URL, or remote branch name to attach."
        },
        title: {
          type: "string",
          description: "Override title (default: from PR metadata or branch commit)."
        },
        body: {
          type: "string",
          description: "Override body/summary (default: from PR body or empty)."
        },
        base: {
          type: "string",
          description: "Override base branch (default: from PR or repo default)."
        },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "update_local_pr",
    description: "Update a local PR title and/or body (the reviewer summary). Use this to fill or refresh the summary before set_status ready.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "get_local_pr",
    description: "Show one local PR by id (prefix allowed). body is the author summary for reviewers. pendingComments are open findings. The implementor inbox only acts on them when status is changes_requested. addressedComments are waiting for the reviewer to resolve. threads nest agent replies under those findings.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "set_status",
    description: "Set local PR status: draft, ready, changes_requested, reviewed, approved. reviewed means the automated reviewer signed off and the human should look. When setting to ready, a preflight check runs automatically to match learned patterns; pass skipPreflight=true to bypass.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "ready", "changes_requested", "reviewed", "approved"]
        },
        skipPreflight: {
          type: "boolean",
          description: "Skip preflight check when setting to ready. Use only when preflight issues are false positives or you want to override."
        },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "add_comment",
    description: "Add a local review comment. role=human is an open finding and sets the loop to changes_requested unless archived. role=reviewer files a finding while status stays ready until complete_review \u2014 except on a reviewed loop, where a new reviewer finding flips to changes_requested so the implementor is woken. role=agent is a reply nested under the last finding unless replyTo is set; Review requested stays a root. Archived loops stay archived. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "body"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        role: { type: "string", enum: ["human", "agent", "reviewer"] },
        author: { type: "string" },
        path: { type: "string" },
        line: { type: "number" },
        side: { type: "string", enum: ["left", "right"] },
        replyTo: { type: "string", description: "Nest this comment under an existing comment id." },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "address_comment",
    description: "Implementor: mark an open finding addressed and attach a reply under it. Addressing the last open finding sets the loop to ready, refreshes HEAD, and posts Review requested so the reviewer queue can pick it up. The reviewer resolves addressed comments. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId", "body"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "resolve_comment",
    description: "Reviewer or human: mark an addressed finding resolved and attach a reply under it. If nothing open or addressed remains, the loop becomes reviewed (ready for human review). Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId", "body"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        role: { type: "string", enum: ["reviewer", "human"] },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "edit_comment",
    description: "Edit the body of an open finding (human or reviewer). Does not change status. Archived loops and non-open findings are refused. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId", "body"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        body: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "delete_comment",
    description: "Delete an open finding and replies under it. Addressed/resolved threads are refused. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "complete_review",
    description: "Reviewer: end of review. Always call this when finished. Open findings set the loop to changes_requested for the implementor. No open findings sets reviewed for the human. Resolves remaining addressed comments. Refuses when HEAD moved after Review requested unless allowDrift=true \u2014 re-diff and file findings first. Archived loops stay archived. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        allowDrift: {
          type: "boolean",
          description: "Finalize even when headSha differs from reviewRequestedSha. Default false."
        },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "get_diff",
    description: "Return name-status and diff for a local PR. Use stat=true for a summary first; use paths to fetch individual files when the full diff would truncate at 80KB.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        cwd: { type: "string" },
        stat: {
          type: "boolean",
          description: "Return git diff --stat instead of the full patch."
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Limit the diff to these paths (after --)."
        }
      }
    }
  },
  {
    name: "delete_local_pr",
    description: "Permanently delete a local PR packet, its refs, and any sibling .loops worktree. Prefer archive via export for shipped work. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "reopen_local_pr",
    description: "Reopen an archived (approved) loop as changes_requested and recreate its worktree. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "watch_status",
    description: "Show listen-loop halt state. inbox is the implementor watch; queue is the reviewer watch. halted is true only when both are halted. Export halt sets both.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "watch_stop",
    description: "Halt listen loops. Omit role to halt both (same as /stop-watch). role=inbox is /stop-loop. role=queue is /stop-review. Does not push or open GitHub.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        role: {
          type: "string",
          enum: ["inbox", "queue"],
          description: "inbox = implementor listen, queue = reviewer listen. Omit to halt both."
        }
      }
    }
  },
  {
    name: "watch_start",
    description: "Resume listen loops. Omit role to resume both. role=inbox is /watch-review-inbox re-arm. role=queue is /watch-ready-prs re-arm. Do not use from a review-inbox/review-queue tick. Creating a new loop also resumes export-halted lanes after that id is archived.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        role: {
          type: "string",
          enum: ["inbox", "queue"],
          description: "inbox = implementor listen, queue = reviewer listen. Omit to resume both."
        }
      }
    }
  },
  {
    name: "export_local_pr",
    description: "Developer command: validate review status and preflight, then halt listen loops, git push, open a GitHub PR, archive the loop, check the main workspace off the loop branch, and remove the extra .loops worktree. Only when the developer explicitly asks to export. Export is blocked unless local review is complete (status reviewed/approved, no pending comments) and preflight pattern checks pass. Use skipValidation only for emergency export.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        cwd: { type: "string" },
        skipValidation: {
          type: "boolean",
          description: "Skip export validation (review status + preflight). Emergency override only."
        }
      }
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
  },
  {
    name: "list_learnings",
    description: "List learned patterns from resolved reviewer findings. Patterns are extracted during complete_review and matched during preflight before ready. Optional disabled filter (true shows only disabled, false shows only enabled, omit for all). Optional category filter.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        disabled: {
          type: "boolean",
          description: "Filter by disabled state. Omit to see all."
        },
        category: {
          type: "string",
          description: "Filter by category (testing, types, style, security, performance, etc.)."
        }
      }
    }
  },
  {
    name: "get_learning",
    description: "Get a single learning by id (prefix match allowed).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "disable_learning",
    description: "Disable a learning so it no longer blocks preflight. Use when a pattern is no longer relevant or was incorrectly extracted.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "enable_learning",
    description: "Re-enable a disabled learning.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "delete_learning",
    description: "Permanently delete a learning. Cannot be undone.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "run_preflight",
    description: "Run preflight check on a local PR to see if any learned patterns would be matched. This is automatically run when set_status ready unless skipPreflight is set. Returns passed boolean and issues array.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "shepherd_status",
    description: "Check shepherd status for a local PR: aggregates review status (reviewed/approved, no pending findings), Learn #18 preflight clean, and gh bind OK. Returns ready or blocked with explicit reasons. Fail-closed: any unknown/missing piece returns blocked.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
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
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "prgenie", version: "0.1.1" }
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      notify("notifications/tools/list_changed");
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
  let buffer = Buffer.alloc(0);
  let draining = false;
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    buffer = Buffer.concat([buffer, bytes]);
    void drain();
  });
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const taken = takeMcpMessages(buffer);
        buffer = Buffer.from(taken.rest);
        if (taken.messages.length === 0) break;
        for (const raw of taken.messages) {
          const msg = raw;
          if (msg && typeof msg === "object" && msg.method) await onRequest(msg);
        }
      }
    } finally {
      draining = false;
    }
  }
}

// packages/cli/src/mcp-bin.ts
void startMcp();
