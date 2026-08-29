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
  "changes_requested",
  "reviewed",
  "approved"
];
var COMMENT_ROLES = ["human", "agent", "reviewer"];
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
  const reopen = Boolean(
    stillExtra && here && dest && sameFsPath(here, dest)
  );
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
async function userName(cwd) {
  const result = await git(cwd, ["config", "user.name"], { allowFail: true });
  return result.stdout.trim() || "local";
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
  const pr = parseJsonObject(await (0, import_promises3.readFile)(file, "utf8"));
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
function isArchivedPr(pr) {
  return pr.status === "approved";
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
    pr.updatedAt = nowIso();
  });
}
async function setLocalPrStatus(cwd, id, status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return withPrLock(cwd, id, (pr) => {
    if (isArchivedPr(pr) && status !== "approved") {
      throw new Error(
        `Loop ${pr.id} is archived. Start a new loop on a feature branch instead of reopening it.`
      );
    }
    pr.status = status;
    pr.updatedAt = nowIso();
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
  if (pr.status !== "ready" && pr.status !== "changes_requested") return;
  const open2 = pendingReviewComments(pr);
  const addressed = addressedReviewComments(pr);
  if (open2.length > 0 || addressed.length > 0) return;
  pr.status = "reviewed";
}
function lastFinding(pr) {
  const findings = (pr.comments ?? []).map(normalizeComment).filter(isFindingComment);
  return findings[findings.length - 1];
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
    const pr = parseJsonObject(await (0, import_promises3.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const comment = {
      id: newId("c"),
      body: text,
      createdAt: nowIso(),
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
    if (!isArchivedPr(pr) && role !== "agent" && comment.status === "open") {
      pr.status = "changes_requested";
    }
    pr.updatedAt = comment.createdAt;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
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
    const pr = parseJsonObject(await (0, import_promises3.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const target = pr.comments.find((c) => c.id === needle || c.id.startsWith(needle));
    if (!target) throw new Error(`Comment not found: ${commentId}`);
    if (!isFindingComment(target)) {
      throw new Error("Only human or reviewer findings can be addressed");
    }
    if (target.status !== "open") {
      throw new Error(`Comment ${target.id} is ${target.status}, not open`);
    }
    const now = nowIso();
    const author = options.author?.trim() || await userName(cwd);
    target.status = "addressed";
    pr.comments.push({
      id: newId("c"),
      body: text,
      createdAt: now,
      author,
      role: "agent",
      status: "resolved",
      replyTo: target.id
    });
    pr.updatedAt = now;
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
    const pr = parseJsonObject(await (0, import_promises3.readFile)(file, "utf8"));
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
    const now = nowIso();
    const author = options.author?.trim() || await userName(cwd);
    target.status = "resolved";
    target.resolvedAt = now;
    target.resolvedBy = author;
    pr.comments.push({
      id: newId("c"),
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
    const pr = parseJsonObject(await (0, import_promises3.readFile)(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const open2 = pendingReviewComments(pr);
    if (open2.length > 0) {
      throw new Error(
        `Open findings remain (${open2.length}). File them as addressed first, or add no new findings and resolve the rest.`
      );
    }
    const now = nowIso();
    const author = options.author?.trim() || await userName(cwd);
    for (const comment of pr.comments) {
      if (isFindingComment(comment) && comment.status === "addressed") {
        comment.status = "resolved";
        comment.resolvedAt = now;
        comment.resolvedBy = author;
      }
    }
    pr.comments.push({
      id: newId("c"),
      body: (options.body?.trim() || "Review complete. Ready for human review.").trim(),
      createdAt: now,
      author,
      role: "reviewer",
      status: "resolved"
    });
    pr.status = "reviewed";
    pr.updatedAt = now;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
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

// packages/core/src/watch.ts
var import_promises4 = require("node:fs/promises");
var import_node_path5 = __toESM(require("node:path"), 1);
function watchFile(dir) {
  return import_node_path5.default.join(dir, "watch.json");
}
var idle = () => ({
  halted: false,
  reason: null,
  exportId: null,
  updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
});
async function getRepoWatch(cwd) {
  const root = await requireGitRoot(cwd);
  try {
    const raw = await (0, import_promises4.readFile)(watchFile(await consoleDir(root)), "utf8");
    const parsed = parseJsonObject(raw);
    return {
      halted: parsed.halted === true,
      reason: parsed.reason === "export" || parsed.reason === "stop" ? parsed.reason : null,
      exportId: parsed.exportId ?? null,
      updatedAt: parsed.updatedAt ?? idle().updatedAt
    };
  } catch {
    return idle();
  }
}
async function haltWatch(cwd, reason, exportId = null) {
  const root = await requireGitRoot(cwd);
  const state = {
    halted: true,
    reason,
    exportId,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeJsonFile(watchFile(await consoleDir(root)), state);
  return state;
}
async function resumeWatch(cwd) {
  const root = await requireGitRoot(cwd);
  const state = {
    halted: false,
    reason: null,
    exportId: null,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeJsonFile(watchFile(await consoleDir(root)), state);
  return state;
}

// packages/core/src/github-ops.ts
var import_node_child_process2 = require("node:child_process");
var import_promises5 = require("node:fs/promises");
var import_node_path6 = __toESM(require("node:path"), 1);

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

// packages/core/src/export.ts
function ghBase(ref) {
  return ref.replace(/^origin\//, "").replace(/^refs\/heads\//, "");
}
async function githubPrStateForHead(cwd, headRef) {
  const result = await runGh(
    ["pr", "view", "--head", headRef, "--json", "state"],
    { cwd }
  );
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
    let state = null;
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
async function exportLocalPr(cwd, id) {
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
    const existing = await runGh(
      ["pr", "view", "--head", pr.headRef, "--json", "url", "-q", ".url"],
      { cwd }
    );
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
    case "list_worktrees":
      return listWorktrees(cwd);
    case "list_local_prs": {
      await archiveLoopsMergedOnGithub(cwd).catch(() => []);
      const prs = (await listLocalPrs(cwd)).map(withCommentViews);
      const status = typeof args.status === "string" ? args.status : "";
      const inbox = args.inbox === true;
      const all = args.all === true;
      return prs.filter((pr) => {
        if (status && pr.status !== status) return false;
        if (!status && !all && isArchivedPr(pr)) return false;
        if (inbox && pr.pendingComments.length === 0) return false;
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
      return setLocalPrStatus(cwd, String(args.id ?? ""), args.status);
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
    case "complete_review":
      return completeLocalPrReview(cwd, String(args.id ?? ""), {
        author: typeof args.author === "string" ? args.author : void 0,
        body: typeof args.body === "string" ? args.body : void 0
      });
    case "get_diff":
      return {
        files: await getLocalPrNameStatus(cwd, String(args.id ?? "")),
        diff: await getLocalPrDiff(cwd, String(args.id ?? ""), { maxBytes: 8e4 })
      };
    case "watch_status":
      return getRepoWatch(cwd);
    case "watch_stop":
      return haltWatch(cwd, "stop");
    case "watch_start":
      return resumeWatch(cwd);
    case "ensure_worktree": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
      const dest = await ensureWorktreeForLoop(cwd, pr, {
        staleLoopIds: (await listLocalPrs(cwd)).filter((p) => p.id !== pr.id && isArchivedPr(p)).map((p) => p.id),
        liveLoopIds: (await listLocalPrs(cwd)).filter((p) => !isArchivedPr(p)).map((p) => p.id)
      });
      return { ...pr, worktreePath: dest };
    }
    case "export_local_pr":
      return exportLocalPr(cwd, String(args.id ?? ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
var tools = [
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
    description: "List unpublished local pull requests. Approved (exported) loops are archived and hidden unless all=true or status=approved. status=ready is the reviewer queue. status=reviewed is waiting on the human. inbox=true is loops with open pendingComments for the implementor.",
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
          description: "Only loops with pending human/reviewer comments."
        },
        all: {
          type: "boolean",
          description: "Include archived (approved/exported) loops. Hidden by default."
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
    description: "Show one local PR by id (prefix allowed). body is the author summary for reviewers. pendingComments are open findings for the implementor. addressedComments are waiting for the reviewer to resolve. threads nest agent replies under those findings.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "set_status",
    description: "Set local PR status: draft, ready, changes_requested, reviewed, approved. reviewed means the automated reviewer signed off and the human should look.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["draft", "ready", "changes_requested", "reviewed", "approved"] },
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "add_comment",
    description: "Add a local review comment. role=human or role=reviewer is an open finding (status=open) and sets the loop to changes_requested unless the loop is already archived (approved). Archived loops stay archived. role=agent is a reply nested under the last finding unless replyTo is set; Review requested stays a root. Do not git push.",
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
    description: "Implementor: mark an open finding addressed and attach a reply under it. Does not set ready. After the inbox is empty, set_status ready and add_comment role=agent Review requested. The reviewer resolves addressed comments. Do not git push.",
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
    name: "complete_review",
    description: "Reviewer: no new findings. Resolves remaining addressed comments and sets the loop to reviewed so the human can review. Fails if open findings remain. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
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
    name: "watch_status",
    description: "Show whether the developer halted the review listen loops (stop or export).",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "watch_stop",
    description: "Developer command: halt reviewer and implementor listen loops. Does not push or open GitHub.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "watch_start",
    description: "Resume listen loops after watch_stop.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } }
  },
  {
    name: "export_local_pr",
    description: "Developer command: halt listen loops, git push, open a GitHub PR, archive the loop, check the main workspace off the loop branch, and remove the extra .loops worktree. Only when the developer explicitly asks to export.",
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
