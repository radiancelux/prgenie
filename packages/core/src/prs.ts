import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { git, gitText, requireGitRoot } from "./git.js";
import { parseJsonObject, prFile, prsDir, withFileLock, writeJsonFile } from "./store.js";
import {
  currentBranch,
  detectDefaultBase,
  listWorktrees,
  shortLogSubject,
  userName,
  worktreeForBranch,
  ensureWorktreeForLoop,
  loopWorktreeDir,
  sameFsPath,
} from "./worktrees.js";
import type {
  CaptureResult,
  CommentRole,
  CreateLocalPrInput,
  LocalPr,
  LocalPrComment,
  LocalPrStatus,
} from "./types.js";
import { COMMENT_ROLES, STATUSES } from "./types.js";

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
    pr.worktreePath = worktreeForBranch(trees, pr.headRef);
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
  const headRef =
    input.head ?? (await currentBranch(cwd)) ?? (await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const headSha = await gitText(cwd, ["rev-parse", input.head ?? "HEAD"]);
  const baseRef = input.base ?? (await detectDefaultBase(cwd));
  const baseResolved = await git(cwd, ["rev-parse", "--verify", baseRef], {
    allowFail: true,
  });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  const baseSha = baseResolved.stdout.trim();
  const title =
    input.title?.trim() ||
    (await shortLogSubject(cwd, headSha).catch(() => "")) ||
    `Local PR from ${headRef}`;
  const createdAt = nowIso();
  const pr: LocalPr = {
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
    reviewRequestedSha: null,
  };
  await writePr(root, pr);
  pr.worktreePath = await ensureWorktreeForLoop(root, pr);
  return pr;
}

export async function updateLocalPr(
  cwd: string,
  id: string,
  patch: { title?: string; body?: string },
): Promise<LocalPr> {
  const pr = await getLocalPr(cwd, id);
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("Title is empty");
    pr.title = title;
  }
  if (patch.body !== undefined) {
    pr.body = patch.body.trim();
  }
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
}

export async function setLocalPrStatus(
  cwd: string,
  id: string,
  status: LocalPrStatus,
): Promise<LocalPr> {
  if (!STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const pr = await getLocalPr(cwd, id);
  pr.status = status;
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
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
  };
}

export function pendingReviewComments(pr: LocalPr): LocalPrComment[] {
  const comments = (pr.comments ?? []).map(normalizeComment);
  const lastAgent = [...comments].reverse().find((c) => c.role === "agent");
  return comments.filter((c) => {
    if (c.role !== "human" && c.role !== "reviewer") return false;
    if (!lastAgent) return true;
    return c.createdAt > lastAgent.createdAt;
  });
}

export function formatReviewInbox(pr: LocalPr): string | null {
  const pending = pendingReviewComments(pr);
  if (pending.length === 0) return null;
  const lines = [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on branch ${pr.headRef} has review comments for the agent working this loop.`,
    `Status is ${pr.status}. Treat the comments below as the brief. Address them on the current branch, commit if needed, then MCP add_comment with role=agent summarizing what you did, then set_status ready. Do not git push.`,
    "",
  ];
  for (const comment of pending) {
    const who =
      comment.role === "reviewer" ? `Reviewer (${comment.author})` : `Human (${comment.author})`;
    const loc = comment.path
      ? ` @ ${comment.path}${comment.line ? `:${comment.line}` : ""}`
      : "";
    lines.push(`${who}${loc} at ${comment.createdAt}:`);
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
    "You are the implementor. Do not review this loop yourself. The reviewer chat should list_local_prs (status=ready) and Task a generalPurpose subagent per loop to run the review.",
    "If you are covering review in this conversation because no reviewer chat exists, Task one generalPurpose reviewer for this id. If several loops are ready, Task one reviewer subagent each, in parallel.",
  ].join("\n");
}

export async function markReviewRequested(cwd: string, id: string): Promise<LocalPr> {
  const pr = await getLocalPr(cwd, id);
  pr.reviewRequestedSha = pr.headSha;
  pr.updatedAt = nowIso();
  await writePr(cwd, pr);
  return pr;
}

export async function findLocalPrForCurrentBranch(cwd: string): Promise<LocalPr | null> {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const matches = (await listLocalPrs(cwd)).filter((pr) => pr.headRef === branch);
  if (matches.length === 0) return null;
  return matches.find((pr) => pr.status === "changes_requested") ?? matches[0];
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
    };
    const loc = options.path?.trim();
    if (loc) comment.path = loc.replace(/\\/g, "/");
    if (options.line && options.line > 0) comment.line = Math.floor(options.line);
    if (options.side === "left" || options.side === "right") comment.side = options.side;
    pr.comments.push(comment);
    if (role !== "agent") {
      pr.status = "changes_requested";
    }
    pr.updatedAt = comment.createdAt;
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
  const headRef =
    input.head ??
    (await currentBranch(cwd)) ??
    (await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const existing = (await listLocalPrs(cwd)).find(
    (pr) => pr.headRef === headRef && pr.status !== "approved",
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
