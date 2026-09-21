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
var COMMENT_STATUSES;
var init_types = __esm({
  "packages/core/src/types.ts"() {
    "use strict";
    COMMENT_STATUSES = ["open", "addressed", "resolved"];
  }
});

// packages/core/src/git.ts
async function git(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
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
function worktreeForLoop(trees, loop) {
  const primary = primaryWorktreePath(trees);
  const dest = primary ? loopWorktreeDir(primary, loop.id) : null;
  if (dest) {
    const own = trees.find((t) => sameFsPath(t.path, dest));
    if (own) return own.path;
  }
  const onBranch = trees.filter((t) => t.branch === loop.headRef);
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
var import_node_fs, import_node_path2;
var init_worktrees = __esm({
  "packages/core/src/worktrees.ts"() {
    "use strict";
    import_node_fs = require("node:fs");
    import_node_path2 = __toESM(require("node:path"), 1);
    init_git();
  }
});

// packages/core/src/store.ts
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
var import_promises, import_node_path3;
var init_store = __esm({
  "packages/core/src/store.ts"() {
    "use strict";
    import_promises = require("node:fs/promises");
    import_node_path3 = __toESM(require("node:path"), 1);
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
function normalizeExportGate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const g = raw;
  if (g.status !== "ready" && g.status !== "blocked" && g.status !== "pending") return null;
  if (typeof g.headSha !== "string" || !g.headSha) return null;
  const reasons = [];
  if (Array.isArray(g.reasons)) {
    for (const item of g.reasons) {
      if (!item || typeof item !== "object") continue;
      const check = item.check;
      const message = item.message;
      if (!GATE_CHECKS.has(check) || typeof message !== "string") continue;
      reasons.push({ check, message });
    }
  }
  const ciPlan = normalizeCiPlan(g.ciPlan);
  const ciChecks = normalizeCiChecks(g.ciChecks);
  return {
    status: g.status,
    reasons,
    headSha: g.headSha,
    evaluatedAt: typeof g.evaluatedAt === "string" ? g.evaluatedAt : null,
    ciPlan,
    ciChecks
  };
}
function normalizeCiPlanReason(raw) {
  if (Array.isArray(raw)) {
    const reasons = raw.filter((r) => typeof r === "string" && r.length > 0);
    return reasons.length ? reasons : null;
  }
  if (typeof raw === "string" && raw.length > 0) return [raw];
  return null;
}
function normalizeCiPlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const plan = raw;
  if (!Array.isArray(plan.checks)) return null;
  const reason = normalizeCiPlanReason(plan.reason);
  if (!reason) return null;
  const checks = plan.checks.filter((c) => typeof c === "string" && c.length > 0);
  if (checks.length === 0) return null;
  return { checks, reason, uncertain: plan.uncertain === true };
}
function normalizeCiChecks(raw) {
  if (!Array.isArray(raw)) return null;
  const checks = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item;
    if (typeof row.name !== "string" || !row.name) continue;
    checks.push({
      name: row.name,
      passed: row.passed === true,
      skipped: row.skipped === true ? true : void 0,
      excerpt: typeof row.excerpt === "string" ? row.excerpt : void 0,
      logPath: typeof row.logPath === "string" ? row.logPath : void 0,
      elapsedMs: typeof row.elapsedMs === "number" ? row.elapsedMs : void 0,
      reason: typeof row.reason === "string" ? row.reason : void 0
    });
  }
  return checks.length ? checks : null;
}
var GATE_CHECKS;
var init_export_gate = __esm({
  "packages/core/src/export-gate.ts"() {
    "use strict";
    GATE_CHECKS = /* @__PURE__ */ new Set(["review", "preflight", "github", "ci"]);
  }
});

// packages/core/src/prs.ts
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
    pr.reviewerNotifiedSha = pr.reviewerNotifiedSha ?? null;
    pr.exportGate = normalizeExportGate(pr.exportGate);
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
var import_promises2, import_node_path4, ALL_SEARCH_FIELDS;
var init_prs = __esm({
  "packages/core/src/prs.ts"() {
    "use strict";
    import_promises2 = require("node:fs/promises");
    import_node_path4 = __toESM(require("node:path"), 1);
    init_git();
    init_store();
    init_worktrees();
    init_types();
    init_watch();
    init_learnings();
    init_export_gate();
    ALL_SEARCH_FIELDS = ["title", "body", "comment", "file"];
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
var init_github = __esm({
  "packages/core/src/github.ts"() {
    "use strict";
  }
});

// packages/core/src/github-ops.ts
var init_github_ops = __esm({
  "packages/core/src/github-ops.ts"() {
    "use strict";
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
    init_prs();
    SCOPABLE_PACKAGES = ["core", "cli", "extension"];
    SCOPABLE_SET = new Set(SCOPABLE_PACKAGES);
  }
});

// packages/core/src/ci-runner.ts
var import_node_child_process2, import_node_util, execAsync;
var init_ci_runner = __esm({
  "packages/core/src/ci-runner.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_node_util = require("node:util");
    init_ci_cache();
    init_ci_failure();
    init_ci_select();
    init_ci_abort();
    init_prs();
    init_progress();
    execAsync = (0, import_node_util.promisify)(import_node_child_process2.exec);
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

// packages/cli/src/review-hook.ts
var import_node_fs2 = require("node:fs");

// packages/core/src/index.ts
init_types();
init_git();

// packages/core/src/mcp-cwd.ts
init_git();

// packages/core/src/index.ts
init_worktrees();
init_prs();
init_watch();

// packages/core/src/review-claim.ts
init_git();
init_prs();
init_store();

// packages/core/src/steward.ts
init_export_gate();
init_export_validation();
init_git();
init_prs();
init_store();

// packages/core/src/doctor.ts
init_git();
init_github_ops();
init_prs();
init_watch();
init_worktrees();
init_ci_failure();

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
init_ci_select();
init_ci_failure();
init_ci_cache();

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
  let input;
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
    silent();
    return;
  }
  silent();
}

// packages/cli/src/review-hook-bin.ts
main().catch(() => {
  process.stdout.write("{}\n");
});
