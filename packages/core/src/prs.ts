import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { git, gitText, requireGitRoot, findGitRoot } from "./git.js";
import { parseJsonObject, prFile, prsDir, withFileLock, writeJsonFile } from "./store.js";
import {
  currentBranch,
  detectDefaultBase,
  ensureLoopFeatureBranch,
  isBaseBranch,
  listWorktrees,
  shortLogSubject,
  userName,
  worktreeForLoop,
  ensureWorktreeForLoop,
  loopWorktreeDir,
  sameFsPath,
} from "./worktrees.js";
import type {
  CaptureResult,
  CommentRole,
  CommentStatus,
  CommentThread,
  CreateLocalPrInput,
  LocalPr,
  LocalPrComment,
  LocalPrStatus,
} from "./types.js";
import { COMMENT_ROLES, COMMENT_STATUSES, STATUSES } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function writePr(cwd: string, pr: LocalPr): Promise<void> {
  const dir = await prsDir(cwd);
  await writeJsonFile(prFile(dir, pr.id), pr);
  await git(cwd, [
    "update-ref",
    `refs/local-pr/${pr.id}/head`,
    pr.headSha,
  ]);
  await git(cwd, ["update-ref", `refs/local-pr/${pr.id}/base`, pr.baseSha]);
  const note = JSON.stringify({
    id: pr.id,
    title: pr.title,
    status: pr.status,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
  });
  await git(
    cwd,
    ["notes", "--ref=local-pr", "add", "-f", "-m", note, pr.headSha],
    { allowFail: true },
  );
}

async function readPrFile(file: string): Promise<LocalPr> {
  const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
  pr.source = pr.source ?? null;
  pr.reviewRequestedSha = pr.reviewRequestedSha ?? null;
  pr.comments = (pr.comments ?? []).map(normalizeComment);
  return pr;
}

/** Lock, re-read, mutate, write — so parallel chats cannot drop comments. */
async function withPrLock(
  cwd: string,
  id: string,
  fn: (pr: LocalPr) => void | Promise<void>,
): Promise<LocalPr> {
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

async function applyHeadRefresh(cwd: string, pr: LocalPr): Promise<void> {
  const named = await git(cwd, ["rev-parse", "--verify", pr.headRef], { allowFail: true });
  if (named.code !== 0) {
    const branch = await currentBranch(cwd);
    if (branch) pr.headRef = branch;
  }
  pr.headSha = await gitText(cwd, ["rev-parse", named.code === 0 ? pr.headRef : "HEAD"]);
  pr.updatedAt = nowIso();
}

export function isArchivedPr(pr: { status: LocalPrStatus }): boolean {
  return pr.status === "approved";
}

export async function listLocalPrs(cwd: string): Promise<LocalPr[]> {
  await requireGitRoot(cwd);
  const dir = await prsDir(cwd);
  const names = await readdir(dir);
  const prs: LocalPr[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(path.join(dir, name), "utf8");
    let pr: LocalPr;
    try {
      pr = parseJsonObject<LocalPr>(raw);
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

export async function getLocalPr(cwd: string, id: string): Promise<LocalPr> {
  const prs = await listLocalPrs(cwd);
  const pr = prs.find((p) => p.id === id || p.id.startsWith(id));
  if (!pr) throw new Error(`Local PR not found: ${id}`);
  return pr;
}

export async function createLocalPr(
  cwd: string,
  input: CreateLocalPrInput = {},
): Promise<LocalPr> {
  const root = await requireGitRoot(cwd);
  const id = newId("lp");
  const baseRef = input.base ?? (await detectDefaultBase(cwd));
  const baseResolved = await git(cwd, ["rev-parse", "--verify", baseRef], {
    allowFail: true,
  });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  const baseSha = baseResolved.stdout.trim();
  const requestedHead =
    input.head ?? (await currentBranch(cwd)) ?? (await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const { headRef, headSha } = await ensureLoopFeatureBranch(root, {
    id,
    requestedHead,
    baseRef,
  });
  const title =
    input.title?.trim() ||
    (await shortLogSubject(cwd, headSha).catch(() => "")) ||
    `Local PR from ${headRef}`;
  const createdAt = nowIso();
  const pr: LocalPr = {
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
  };
  await writePr(root, pr);
  const others = await listLocalPrs(root);
  pr.worktreePath = await ensureWorktreeForLoop(root, pr, {
    staleLoopIds: others.filter((other) => other.id !== pr.id && isArchivedPr(other)).map((other) => other.id),
    liveLoopIds: others.filter((other) => !isArchivedPr(other)).map((other) => other.id),
  });
  return pr;
}

export async function updateLocalPr(
  cwd: string,
  id: string,
  patch: { title?: string; body?: string },
): Promise<LocalPr> {
  return withPrLock(cwd, id, (pr) => {
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("Title is empty");
      pr.title = title;
    }
    if (patch.body !== undefined) {
      pr.body = patch.body.trim();
    }
    pr.updatedAt = nowIso();
  });
}

export async function setLocalPrStatus(
  cwd: string,
  id: string,
  status: LocalPrStatus,
): Promise<LocalPr> {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr) && status !== "approved") {
      throw new Error(
        `Loop ${pr.id} is archived. Start a new loop on a feature branch instead of reopening it.`,
      );
    }
    pr.status = status;
    if (status === "ready") await applyHeadRefresh(cwd, pr);
    pr.updatedAt = nowIso();
  });
}

export function isReviewRequestBody(body: string): boolean {
  return /^review requested\.?$/i.test(body.trim());
}

function inferCommentStatus(comment: LocalPrComment, role: CommentRole): CommentStatus {
  if (comment.status && COMMENT_STATUSES.includes(comment.status)) return comment.status;
  if (comment.resolvedAt) return "resolved";
  if (comment.replyTo || role === "agent") return "resolved";
  return "open";
}

export function normalizeComment(comment: LocalPrComment): LocalPrComment {
  const role: CommentRole =
    comment.role === "agent" || comment.role === "reviewer" || comment.role === "human"
      ? comment.role
      : "human";
  return {
    ...comment,
    author: comment.author || "reviewer",
    role,
    status: inferCommentStatus(comment, role),
  };
}

export function isFindingComment(comment: LocalPrComment): boolean {
  const c = normalizeComment(comment);
  if (c.role !== "human" && c.role !== "reviewer") return false;
  if (c.replyTo) return false;
  return true;
}

export function pendingReviewComments(pr: LocalPr): LocalPrComment[] {
  return (pr.comments ?? []).map(normalizeComment).filter((c) => isFindingComment(c) && c.status === "open");
}

export function addressedReviewComments(pr: LocalPr): LocalPrComment[] {
  return (pr.comments ?? [])
    .map(normalizeComment)
    .filter((c) => isFindingComment(c) && c.status === "addressed");
}

export function commentThreads(comments: LocalPrComment[]): CommentThread[] {
  const list = (comments ?? []).map(normalizeComment);
  const ids = new Set(list.map((c) => c.id));
  const assigned = new Set<string>();
  const repliesByParent = new Map<string, LocalPrComment[]>();
  for (const c of list) {
    if (c.replyTo && ids.has(c.replyTo)) {
      const bucket = repliesByParent.get(c.replyTo) ?? [];
      bucket.push(c);
      repliesByParent.set(c.replyTo, bucket);
      assigned.add(c.id);
    }
  }
  const threads: CommentThread[] = [];
  let lastFinding: CommentThread | undefined;
  for (const c of list) {
    if (assigned.has(c.id)) continue;
    if (c.role === "agent" && !isReviewRequestBody(c.body) && lastFinding) {
      lastFinding.replies.push(c);
      continue;
    }
    const thread: CommentThread = { root: c, replies: repliesByParent.get(c.id) ?? [] };
    threads.push(thread);
    if (isFindingComment(c)) lastFinding = thread;
  }
  return threads;
}

function maybePromoteToReviewed(pr: LocalPr): void {
  // Only auto-finish from changes_requested (human resolving the last finding).
  // A ready loop is still with the reviewer until complete_review.
  if (pr.status !== "changes_requested") return;
  const open = pendingReviewComments(pr);
  const addressed = addressedReviewComments(pr);
  if (open.length > 0 || addressed.length > 0) return;
  pr.status = "reviewed";
}

async function maybeHandoffToReviewer(
  cwd: string,
  pr: LocalPr,
  now: string,
  author: string,
): Promise<void> {
  if (isArchivedPr(pr)) return;
  if (pr.status !== "changes_requested") return;
  if (pendingReviewComments(pr).length > 0) return;
  await applyHeadRefresh(cwd, pr);
  pr.status = "ready";
  pr.comments.push({
    id: newId("c"),
    body: "Review requested.",
    createdAt: now,
    author,
    role: "agent",
    status: "resolved",
  });
  pr.updatedAt = now;
}

function lastFinding(pr: LocalPr): LocalPrComment | undefined {
  const findings = (pr.comments ?? []).map(normalizeComment).filter(isFindingComment);
  return findings[findings.length - 1];
}

export function formatReviewInbox(pr: LocalPr): string | null {
  if (pr.status !== "changes_requested") return null;
  const pending = pendingReviewComments(pr);
  if (pending.length === 0) return null;
  const lines = [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on branch ${pr.headRef} has review comments for the agent working this loop.`,
    `Status is ${pr.status}. Address each open comment with MCP address_comment (this loop id, that commentId, and a reply). Addressing the last open finding sets the loop to ready and posts Review requested. The reviewer resolves addressed comments. Do not git push.`,
    "",
  ];
  for (const comment of pending) {
    const who =
      comment.role === "reviewer" ? `Reviewer (${comment.author})` : `Human (${comment.author})`;
    const loc = comment.path
      ? ` @ ${comment.path}${comment.line ? `:${comment.line}` : ""}`
      : "";
    lines.push(`${who} [${comment.id}] open${loc} at ${comment.createdAt}:`);
    lines.push(comment.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function shouldSpawnReviewer(pr: LocalPr): boolean {
  return pr.status === "ready" && (pr.reviewRequestedSha ?? null) !== pr.headSha;
}

export function formatSpawnReviewer(pr: LocalPr): string {
  return [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on ${pr.headRef} is ready.`,
    "That is the review request. add_comment role=agent \"Review requested.\" if you have not already. Do not git push.",
    "You are the implementor. Do not review this loop yourself. The reviewer chat should list_local_prs (status=ready) and Task a generalPurpose subagent per loop. Do not await those Tasks in the listen loop.",
    "If you are covering review in this conversation because no reviewer chat exists, Task one generalPurpose reviewer for this id. If several loops are ready, Task one reviewer subagent each, in parallel. Do not sit waiting on them.",
  ].join("\n");
}

export async function markReviewRequested(cwd: string, id: string): Promise<LocalPr> {
  return withPrLock(cwd, id, (pr) => {
    pr.reviewRequestedSha = pr.headSha;
    pr.updatedAt = nowIso();
  });
}

export async function findLocalPrForCurrentBranch(cwd: string): Promise<LocalPr | null> {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const matches = (await listLocalPrs(cwd)).filter(
    (pr) => pr.headRef === branch && !isArchivedPr(pr),
  );
  if (matches.length === 0) return null;
  return matches.find((pr) => pr.status === "changes_requested") ?? matches[0];
}

/** Live loop for this checkout only — never another branch's packet. */
export async function findLocalPrForCurrentWorktree(cwd: string): Promise<LocalPr | null> {
  const byBranch = await findLocalPrForCurrentBranch(cwd);
  if (byBranch) return byBranch;
  const branch = await currentBranch(cwd);
  if (branch) return null;
  const root = await findGitRoot(cwd);
  if (!root) return null;
  const live = (await listLocalPrs(cwd)).filter((pr) => !isArchivedPr(pr) && pr.worktreePath);
  return live.find((pr) => sameFsPath(pr.worktreePath ?? "", root)) ?? null;
}

export async function addLocalPrComment(
  cwd: string,
  id: string,
  body: string,
  options: {
    role?: CommentRole;
    author?: string;
    path?: string;
    line?: number;
    side?: "left" | "right";
    replyTo?: string;
  } = {},
): Promise<LocalPr> {
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
    const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const comment: LocalPrComment = {
      id: newId("c"),
      body: text,
      createdAt: nowIso(),
      author: options.author?.trim() || (await userName(cwd)),
      role,
      status: role === "agent" ? "resolved" : "open",
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
    if (
      !isArchivedPr(pr) &&
      role !== "agent" &&
      role !== "reviewer" &&
      comment.status === "open"
    ) {
      pr.status = "changes_requested";
    }
    pr.updatedAt = comment.createdAt;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}

export async function addressLocalPrComment(
  cwd: string,
  id: string,
  commentId: string,
  body: string,
  options: { author?: string } = {},
): Promise<LocalPr> {
  const text = body.trim();
  if (!text) throw new Error("Address comment is empty");
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
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
    const author = options.author?.trim() || (await userName(cwd));
    target.status = "addressed";
    pr.comments.push({
      id: newId("c"),
      body: text,
      createdAt: now,
      author,
      role: "agent",
      status: "resolved",
      replyTo: target.id,
    });
    pr.updatedAt = now;
    await maybeHandoffToReviewer(cwd, pr, now, author);
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}

export async function resolveLocalPrComment(
  cwd: string,
  id: string,
  commentId: string,
  body: string,
  options: { author?: string; role?: CommentRole } = {},
): Promise<LocalPr> {
  const text = body.trim();
  if (!text) throw new Error("Resolution comment is empty");
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  const role = options.role === "human" ? "human" : "reviewer";
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
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
        `Comment ${target.id} is still open. The implementor must address_comment it before the reviewer resolves it.`,
      );
    }
    const now = nowIso();
    const author = options.author?.trim() || (await userName(cwd));
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
      replyTo: target.id,
    });
    pr.updatedAt = now;
    maybePromoteToReviewed(pr);
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}

export async function completeLocalPrReview(
  cwd: string,
  id: string,
  options: { author?: string; body?: string } = {},
): Promise<LocalPr> {
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const open = pendingReviewComments(pr);
    const now = nowIso();
    const author = options.author?.trim() || (await userName(cwd));
    for (const comment of pr.comments) {
      if (isFindingComment(comment) && comment.status === "addressed") {
        comment.status = "resolved";
        comment.resolvedAt = now;
        comment.resolvedBy = author;
      }
    }
    const handedToImplementor = open.length > 0;
    pr.comments.push({
      id: newId("c"),
      body: (
        options.body?.trim() ||
        (handedToImplementor
          ? "Review complete. Findings are ready for the implementor."
          : "Review complete. Ready for human review.")
      ).trim(),
      createdAt: now,
      author,
      role: "reviewer",
      status: "resolved",
    });
    if (!isArchivedPr(pr)) {
      pr.status = handedToImplementor ? "changes_requested" : "reviewed";
    }
    pr.updatedAt = now;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}

export async function getLocalPrDiff(
  cwd: string,
  id: string,
  options: { stat?: boolean; maxBytes?: number } = {},
): Promise<string> {
  const pr = await getLocalPr(cwd, id);
  const args = options.stat
    ? ["diff", "--stat", `${pr.baseSha}...${pr.headSha}`]
    : ["diff", `${pr.baseSha}...${pr.headSha}`];
  const { stdout } = await git(cwd, args);
  const max = options.maxBytes ?? 200_000;
  if (stdout.length > max) {
    return `${stdout.slice(0, max)}\n\n... truncated (${stdout.length} bytes) ...`;
  }
  return stdout;
}

export async function getLocalPrNameStatus(
  cwd: string,
  id: string,
): Promise<{ status: string; path: string }[]> {
  const pr = await getLocalPr(cwd, id);
  const { stdout } = await git(cwd, [
    "diff",
    "--name-status",
    `${pr.baseSha}...${pr.headSha}`,
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

export async function refreshLocalPrHead(
  cwd: string,
  id: string,
): Promise<LocalPr> {
  return withPrLock(cwd, id, (pr) => applyHeadRefresh(cwd, pr));
}

export async function hasCommitsAheadOfBase(
  cwd: string,
  baseRef?: string,
): Promise<boolean> {
  const base = baseRef ?? (await detectDefaultBase(cwd));
  const ahead = await git(cwd, ["rev-list", "--count", `${base}..HEAD`], {
    allowFail: true,
  });
  if (ahead.code !== 0) return false;
  return Number(ahead.stdout.trim()) > 0;
}

export async function captureAgentWork(
  cwd: string,
  input: CreateLocalPrInput = {},
): Promise<CaptureResult> {
  await requireGitRoot(cwd);
  if (!(await hasCommitsAheadOfBase(cwd, input.base))) {
    return {
      action: "skipped",
      reason: "no commits ahead of base",
    };
  }
  const baseRef = input.base ?? (await detectDefaultBase(cwd));
  const headRef =
    input.head ??
    (await currentBranch(cwd)) ??
    (await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const existing = isBaseBranch(headRef, baseRef)
    ? undefined
    : (await listLocalPrs(cwd)).find(
        (pr) => pr.headRef === headRef && !isArchivedPr(pr),
      );
  if (existing) {
    const prevSha = existing.headSha;
    const updated = await withPrLock(cwd, existing.id, async (pr) => {
      if (input.source) pr.source = input.source;
      if (input.title?.trim()) pr.title = input.title.trim();
      if (input.body?.trim()) pr.body = input.body.trim();
      await applyHeadRefresh(cwd, pr);
      if (pr.status === "reviewed" && pr.headSha !== prevSha) {
        pr.status = "ready";
      }
    });
    updated.worktreePath = await ensureWorktreeForLoop(cwd, updated, {
      staleLoopIds: (await listLocalPrs(cwd))
        .filter((other) => other.id !== updated.id && isArchivedPr(other))
        .map((other) => other.id),
      liveLoopIds: (await listLocalPrs(cwd))
        .filter((other) => !isArchivedPr(other))
        .map((other) => other.id),
    });
    return { action: "updated", pr: updated };
  }
  const pr = await createLocalPr(cwd, input);
  return { action: "created", pr };
}
