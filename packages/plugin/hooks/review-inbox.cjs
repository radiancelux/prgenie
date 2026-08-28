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
var import_node_fs = require("node:fs");

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
function worktreeForBranch(trees, branch) {
  const match = trees.find((t) => t.branch === branch);
  return match?.path ?? null;
}

// packages/core/src/prs.ts
var import_promises2 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"), 1);

// packages/core/src/store.ts
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"), 1);
async function consoleDir(cwd) {
  const common = await gitCommonDir(cwd);
  const dir = import_node_path2.default.join(common, "agent-console");
  await (0, import_promises.mkdir)(dir, { recursive: true });
  return dir;
}
async function prsDir(cwd) {
  const dir = import_node_path2.default.join(await consoleDir(cwd), "prs");
  await (0, import_promises.mkdir)(dir, { recursive: true });
  return dir;
}
function prFile(dir, id) {
  return import_node_path2.default.join(dir, `${id}.json`);
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
async function listLocalPrs(cwd) {
  await requireGitRoot(cwd);
  const dir = await prsDir(cwd);
  const names = await (0, import_promises2.readdir)(dir);
  const prs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await (0, import_promises2.readFile)(import_node_path3.default.join(dir, name), "utf8");
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
function normalizeComment(comment) {
  const role = comment.role === "agent" || comment.role === "reviewer" || comment.role === "human" ? comment.role : "human";
  return {
    ...comment,
    author: comment.author || "reviewer",
    role
  };
}
function pendingReviewComments(pr) {
  const comments = (pr.comments ?? []).map(normalizeComment);
  const lastAgent = [...comments].reverse().find((c) => c.role === "agent");
  return comments.filter((c) => {
    if (c.role !== "human" && c.role !== "reviewer") return false;
    if (!lastAgent) return true;
    return c.createdAt > lastAgent.createdAt;
  });
}
function formatReviewInbox(pr) {
  const pending = pendingReviewComments(pr);
  if (pending.length === 0) return null;
  const lines = [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on branch ${pr.headRef} has review comments for the agent working this loop.`,
    `Status is ${pr.status}. Treat the comments below as the brief. Address them on the current branch, commit if needed, then MCP add_comment with role=agent summarizing what you did, then set_status ready. Do not git push.`,
    ""
  ];
  for (const comment of pending) {
    const who = comment.role === "reviewer" ? `Reviewer (${comment.author})` : `Human (${comment.author})`;
    const loc = comment.path ? ` @ ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
    lines.push(`${who}${loc} at ${comment.createdAt}:`);
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
    "You are the implementor. Do not review this loop yourself. The reviewer chat should list_local_prs (status=ready) and Task a generalPurpose subagent per loop to run the review.",
    "If you are covering review in this conversation because no reviewer chat exists, Task one generalPurpose reviewer for this id. If several loops are ready, Task one reviewer subagent each, in parallel."
  ].join("\n");
}
async function markReviewRequested(cwd, id) {
  const pr = await getLocalPr(cwd, id);
  pr.reviewRequestedSha = pr.headSha;
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
}
async function findLocalPrForCurrentBranch(cwd) {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const matches = (await listLocalPrs(cwd)).filter((pr) => pr.headRef === branch);
  if (matches.length === 0) return null;
  return matches.find((pr) => pr.status === "changes_requested") ?? matches[0];
}
async function refreshLocalPrHead(cwd, id) {
  const pr = await getLocalPr(cwd, id);
  const sha = await gitText(cwd, ["rev-parse", pr.headRef]);
  pr.headSha = sha;
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
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
    const raw = (0, import_node_fs.readFileSync)(0, "utf8");
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
  const pr = await findLocalPrForCurrentBranch(root);
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
