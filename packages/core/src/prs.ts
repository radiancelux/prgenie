import { randomBytes } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
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
  releaseArchivedLoop,
  sameFsPath,
} from "./worktrees.js";
import type {
  CaptureResult,
  CommentRole,
  CommentStatus,
  CommentThread,
  CreateLocalPrInput,
  ExportGateSnapshot,
  LocalPr,
  LocalPrComment,
  LocalPrStatus,
  LocalPrSource,
  ReadyCiRecord,
} from "./types.js";
import { COMMENT_ROLES, COMMENT_STATUSES, STATUSES } from "./types.js";
import { getRepoWatch, resumeWatchRole } from "./watch.js";
import { addLearnings, extractLearningsFromResolvedComments, runPreflight } from "./learnings.js";
import { normalizeExportGate, pendingExportGate } from "./export-gate.js";
import { assertNoDirtyPluginBuildArtifacts } from "./plugin-dirt.js";
import {
  assertReadyCiSatisfied,
  isReadyCiSatisfied,
  normalizeReadyCi,
  parseCiSkipReason,
  readyCiFromSkipReason,
  tipScopedCiSkipReason,
  upsertReviewRequestedComment,
} from "./ready-ci.js";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function writePr(cwd: string, pr: LocalPr): Promise<void> {
  const dir = await prsDir(cwd);
  await writeJsonFile(prFile(dir, pr.id), pr);
  await git(cwd, ["update-ref", `refs/local-pr/${pr.id}/head`, pr.headSha]);
  await git(cwd, ["update-ref", `refs/local-pr/${pr.id}/base`, pr.baseSha]);
  const note = JSON.stringify({
    id: pr.id,
    title: pr.title,
    status: pr.status,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
  });
  await git(cwd, ["notes", "--ref=local-pr", "add", "-f", "-m", note, pr.headSha], {
    allowFail: true,
  });
}

async function readPrFile(file: string): Promise<LocalPr> {
  const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
  pr.source = pr.source ?? null;
  pr.reviewRequestedSha = pr.reviewRequestedSha ?? null;
  pr.reviewerNotifiedSha = pr.reviewerNotifiedSha ?? null;
  pr.readyCi = normalizeReadyCi(pr.readyCi);
  pr.exportGate = normalizeExportGate(pr.exportGate);
  pr.comments = (pr.comments ?? []).map(normalizeComment);
  return pr;
}

/**
 * Disk + worktree overlay lookup without refreshing headSha.
 * Prefer {@link getLocalPr} for agent/MCP reads (RAD-125 refreshes tip).
 */
async function findLocalPr(cwd: string, id: string): Promise<LocalPr> {
  const prs = await listLocalPrs(cwd);
  const pr = prs.find((p) => p.id === id || p.id.startsWith(id));
  if (!pr) throw new Error(`Local PR not found: ${id}`);
  return pr;
}

/** Lock, re-read, mutate, write — so parallel chats cannot drop comments. */
async function withPrLock(
  cwd: string,
  id: string,
  fn: (pr: LocalPr) => void | Promise<void>,
): Promise<LocalPr> {
  const resolved = await findLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = await readPrFile(file);
    await fn(pr);
    // Persist live worktree overlay so packet worktreePath / ciCwd are not null on disk (RAD-123).
    // Also clear a stale on-disk path when the live overlay is null (pruned worktree).
    if (resolved.worktreePath) {
      pr.worktreePath = resolved.worktreePath;
    } else if (pr.worktreePath) {
      pr.worktreePath = null;
    }
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath ?? pr.worktreePath;
    return pr;
  });
}

/**
 * Resolve loop tip from the exclusive worktree when present; else branch/HEAD in cwd.
 * Worktree commits update the shared branch, but reading HEAD in the worktree is the
 * authoritative tip for agent decisions (RAD-125).
 *
 * Only trust paths from `listWorktrees` / `worktreeForLoop`. Never fall back to the
 * on-disk packet `worktreePath` — a pruned path throws and breaks refresh / steward_next.
 */
async function resolveLoopHeadTip(
  cwd: string,
  pr: Pick<LocalPr, "id" | "headRef" | "worktreePath">,
): Promise<{ headRef: string; headSha: string }> {
  const trees = await listWorktrees(cwd);
  const wt = worktreeForLoop(trees, pr);
  if (wt) {
    const headSha = await gitText(wt, ["rev-parse", "HEAD"]);
    const branch = await currentBranch(wt);
    return { headRef: branch ?? pr.headRef, headSha };
  }
  const named = await git(cwd, ["rev-parse", "--verify", pr.headRef], { allowFail: true });
  if (named.code === 0) {
    return {
      headRef: pr.headRef,
      headSha: await gitText(cwd, ["rev-parse", pr.headRef]),
    };
  }
  const branch = await currentBranch(cwd);
  const headRef = branch ?? pr.headRef;
  return {
    headRef,
    headSha: await gitText(cwd, ["rev-parse", "HEAD"]),
  };
}

/**
 * When a reviewed loop's tip moves, clear the review verdict until Reviewer
 * re-clears that SHA (RAD-126). Default is re-review — no mechanical allowlist.
 */
export function invalidateReviewedOnHeadMove(pr: LocalPr, previousHeadSha: string): boolean {
  if (pr.status !== "reviewed") return false;
  if (!previousHeadSha || pr.headSha === previousHeadSha) return false;
  pr.status = "ready";
  pr.reviewRequestedSha = pr.headSha;
  pr.reviewerNotifiedSha = null;
  pr.exportGate = null;
  return true;
}

async function applyHeadRefresh(cwd: string, pr: LocalPr): Promise<void> {
  const previousHeadSha = pr.headSha;
  const tip = await resolveLoopHeadTip(cwd, pr);
  pr.headRef = tip.headRef;
  pr.headSha = tip.headSha;
  invalidateReviewedOnHeadMove(pr, previousHeadSha);
  pr.updatedAt = nowIso();
}

export function isArchivedPr(pr: { status: LocalPrStatus }): boolean {
  return pr.status === "approved";
}

export async function listCorruptLocalPrFiles(cwd: string): Promise<string[]> {
  await requireGitRoot(cwd);
  const dir = await prsDir(cwd);
  const names = await readdir(dir);
  const corrupt: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      parseJsonObject<LocalPr>(await readFile(file, "utf8"));
    } catch {
      corrupt.push(file);
    }
  }
  return corrupt;
}

export type LocalPrSearchField = "title" | "body" | "comment" | "file";

export type ListLocalPrsOptions = {
  /**
   * Case-insensitive substring match across title, body, comment bodies,
   * comment paths, and changed file paths (base...head). Empty = no filter.
   */
  search?: string;
  /** Restrict which fields search matches. Default: all four. */
  in?: LocalPrSearchField[];
};

const ALL_SEARCH_FIELDS: LocalPrSearchField[] = ["title", "body", "comment", "file"];

export function normalizeLocalPrSearchFields(
  fields?: LocalPrSearchField[],
): Set<LocalPrSearchField> {
  if (!fields?.length) return new Set(ALL_SEARCH_FIELDS);
  const out = new Set<LocalPrSearchField>();
  for (const f of fields) {
    if (ALL_SEARCH_FIELDS.includes(f)) out.add(f);
  }
  return out.size ? out : new Set(ALL_SEARCH_FIELDS);
}

/** Pure match helper (pass changed file paths when testing file without git). */
export function localPrMatchesSearch(
  pr: LocalPr,
  query: string,
  options: { fields?: Iterable<LocalPrSearchField>; files?: string[] } = {},
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const fields = normalizeLocalPrSearchFields(options.fields ? [...options.fields] : undefined);
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

async function changedFilePathsForPr(cwd: string, pr: LocalPr): Promise<string[]> {
  const range = `${pr.baseSha}...${pr.headRef}`;
  const primary = await git(cwd, ["diff", "--name-only", range], { allowFail: true });
  const stdout =
    primary.code === 0 && primary.stdout.trim()
      ? primary.stdout
      : (
          await git(cwd, ["diff", "--name-only", `${pr.baseSha}...${pr.headSha}`], {
            allowFail: true,
          })
        ).stdout;
  if (!stdout.trim()) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function listLocalPrs(
  cwd: string,
  options: ListLocalPrsOptions = {},
): Promise<LocalPr[]> {
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
    pr.reviewerNotifiedSha = pr.reviewerNotifiedSha ?? null;
    pr.readyCi = normalizeReadyCi(pr.readyCi);
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
  const matched: LocalPr[] = [];
  for (const pr of prs) {
    if (
      localPrMatchesSearch(pr, search, {
        fields,
        files: needFiles ? [] : undefined,
      })
    ) {
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
/**
 * Show one local PR (disk + worktreePath overlay).
 * Does **not** persist a tip refresh — that avoids nested file locks with `withPrLock`.
 * For a tip that matches the worktree HEAD (and RAD-126 invalidate), use
 * {@link refreshLocalPrHead} or MCP `get_local_pr` (which refreshes).
 * `list_local_prs` also skips head refresh (read-only listing).
 */
export async function getLocalPr(cwd: string, id: string): Promise<LocalPr> {
  return findLocalPr(cwd, id);
}

/** Export halt lasts until the next loop. Stop halt never auto-resumes, including one-sided stop. */
export async function resumeWatchForNextLoop(cwd: string): Promise<void> {
  const watch = await getRepoWatch(cwd);
  for (const role of ["inbox", "queue"] as const) {
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

export async function createLocalPr(cwd: string, input: CreateLocalPrInput = {}): Promise<LocalPr> {
  const root = await requireGitRoot(cwd);
  await assertNoDirtyPluginBuildArtifacts(root);
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
    input.head ??
    (await currentBranch(cwd)) ??
    (await gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
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
  // RAD-94: persist declared baseRef + baseSha at create; ready/CI/export enforce alignment.
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
    reviewerNotifiedSha: null,
    readyCi: null,
  };
  await writePr(root, pr);
  const others = await listLocalPrs(root);
  pr.worktreePath = await ensureWorktreeForLoop(root, pr, {
    staleLoopIds: others
      .filter((other) => other.id !== pr.id && isArchivedPr(other))
      .map((other) => other.id),
    liveLoopIds: others.filter((other) => !isArchivedPr(other)).map((other) => other.id),
  });
  await resumeWatchForNextLoop(root);
  return pr;
}

export async function updateLocalPr(
  cwd: string,
  id: string,
  patch: { title?: string; body?: string },
): Promise<LocalPr> {
  return withPrLock(cwd, id, async (pr) => {
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("Title is empty");
      pr.title = title;
    }
    if (patch.body !== undefined) {
      pr.body = patch.body.trim();
    }
    // After implementor commits, refresh headSha without a manual JSON edit (RAD-125).
    await applyHeadRefresh(cwd, pr);
  });
}

export async function setLocalPrStatus(
  cwd: string,
  id: string,
  status: LocalPrStatus,
  options: { skipPreflight?: boolean; ciSkipReason?: string } = {},
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
    if (status === "ready") {
      // RAD-94: refresh tip then refuse ready when merge-base ≠ declared base (or stacked).
      await applyHeadRefresh(cwd, pr);
      const { assertDeclaredBaseAligned } = await import("./base-ref.js");
      await assertDeclaredBaseAligned(cwd, pr);
      // RAD-97: soft-block before pattern preflight (fail fast; avoid diff work when CI missing).
      applyReadyCiGate(pr, options.ciSkipReason);
    }
    if (status === "ready" && !options.skipPreflight) {
      const preflight = await runPreflight(cwd, pr);
      if (!preflight.passed) {
        const summary = preflight.issues
          .map(
            (issue) =>
              `- [${issue.learningId}] Pattern: "${issue.pattern}" (matched in ${issue.matchedIn})\n  Guidance: ${issue.guidance}`,
          )
          .join("\n");
        throw new Error(
          `Preflight failed — ${preflight.issues.length} learned pattern(s) detected:\n\n${summary}\n\nAddress these patterns or disable the learnings, then try ready again. Use skipPreflight=true to bypass.`,
        );
      }
    }
    if (status === "ready") {
      await armReviewRequest(cwd, pr);
    }
    if (status === "review_interrupted") {
      if (pr.status !== "ready" && pr.status !== "review_interrupted") {
        throw new Error(
          `review_interrupted requires status ready (got ${pr.status}). Mark ready first, then interrupt on auth failure.`,
        );
      }
    }
    pr.status = status;
    if (status === "reviewed") pr.exportGate = pendingExportGate(pr.headSha);
    if (status !== "ready" && status !== "review_interrupted") {
      // Leaving the review lane — readyCi stays as evidence for this SHA.
    }
    pr.updatedAt = nowIso();
  });
}

/** Soft-block / record skip for ready (RAD-97). Mutates pr.readyCi. */
function applyReadyCiGate(pr: LocalPr, ciSkipReason?: string): void {
  if (ciSkipReason?.trim()) {
    pr.readyCi = readyCiFromSkipReason(pr.headSha, ciSkipReason.trim());
    return;
  }
  if (isReadyCiSatisfied(pr)) return;
  // Promote only tip-scoped "CI skipped: …" comments (forSha === HEAD) into readyCi.
  const tipSkip = tipScopedCiSkipReason(pr, pr.headSha);
  if (tipSkip) {
    pr.readyCi = readyCiFromSkipReason(pr.headSha, tipSkip);
    return;
  }
  assertReadyCiSatisfied(pr);
}

/** Persist implementor CI result onto the loop packet (RAD-97). */
export async function recordLocalPrReadyCi(
  cwd: string,
  id: string,
  record: ReadyCiRecord | null,
): Promise<LocalPr> {
  return withPrLock(cwd, id, async (pr) => {
    await applyHeadRefresh(cwd, pr);
    if (record) {
      pr.readyCi = { ...record, headSha: record.headSha || pr.headSha };
    } else {
      pr.readyCi = null;
    }
    pr.updatedAt = nowIso();
  });
}

/**
 * Auth / host failure while a reviewer Task was in flight (RAD-97).
 * Keeps reviewRequestedSha and steward reviewerTaskId; steward resumes without re-brief.
 */
export async function markReviewInterrupted(
  cwd: string,
  id: string,
  options: { reason?: string } = {},
): Promise<LocalPr> {
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr)) throw new Error(`Loop ${pr.id} is archived.`);
    if (pr.status !== "ready" && pr.status !== "review_interrupted") {
      throw new Error(`markReviewInterrupted requires status ready (got ${pr.status}).`);
    }
    pr.status = "review_interrupted";
    const reason = options.reason?.trim() || "auth failure";
    const note = `Review interrupted: ${reason}. Resume with prgenie review-resume ${pr.id} / MCP resume_review (same reviewer Task — no re-brief).`;
    const already = (pr.comments ?? []).some(
      (c) => c.role === "agent" && !c.replyTo && c.body.startsWith("Review interrupted:"),
    );
    if (!already) {
      pr.comments.push({
        id: newId("c"),
        body: note,
        createdAt: nowIso(),
        author: "prgenie",
        role: "agent",
        status: "resolved",
      });
    }
    pr.updatedAt = nowIso();
  });
}

/**
 * One-command resume after review_interrupted (RAD-97).
 * Returns ready + clears interrupt so steward can resume the same reviewer Task.
 */
export async function resumeReview(cwd: string, id: string): Promise<LocalPr> {
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr)) throw new Error(`Loop ${pr.id} is archived.`);
    if (pr.status !== "review_interrupted" && pr.status !== "ready") {
      throw new Error(`resumeReview expects review_interrupted or ready (got ${pr.status}).`);
    }
    await applyHeadRefresh(cwd, pr);
    pr.status = "ready";
    // Keep reviewRequestedSha — do not re-arm / do not require a new readyCi for resume.
    if (!pr.reviewRequestedSha) {
      pr.reviewRequestedSha = pr.headSha;
    }
    pr.updatedAt = nowIso();
  });
}

export async function setLocalPrExportGate(
  cwd: string,
  id: string,
  gate: ExportGateSnapshot | null,
): Promise<LocalPr> {
  return withPrLock(cwd, id, (pr) => {
    pr.exportGate = gate ? normalizeExportGate(gate) : null;
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
  return (pr.comments ?? [])
    .map(normalizeComment)
    .filter((c) => isFindingComment(c) && c.status === "open");
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
  pr.exportGate = pendingExportGate(pr.headSha);
}

async function armReviewRequest(cwd: string, pr: LocalPr): Promise<void> {
  await applyHeadRefresh(cwd, pr);
  pr.reviewRequestedSha = pr.headSha;
  // New ready cycle — allow one implementor-chat spawn reminder for this HEAD.
  pr.reviewerNotifiedSha = null;
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
  applyReadyCiGate(pr);
  await armReviewRequest(cwd, pr);
  // RAD-94: same gate as set_status ready — refuse handoff when base is misaligned.
  const { assertDeclaredBaseAligned } = await import("./base-ref.js");
  await assertDeclaredBaseAligned(cwd, pr);
  pr.status = "ready";
  upsertReviewRequestedComment(pr, now, author, pr.headSha, newId("c"));
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
    const loc = comment.path ? ` @ ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
    lines.push(`${who} [${comment.id}] open${loc} at ${comment.createdAt}:`);
    lines.push(comment.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function shouldSpawnReviewer(pr: LocalPr): boolean {
  return (
    (pr.status === "ready" || pr.status === "review_interrupted") &&
    (pr.reviewerNotifiedSha ?? null) !== pr.headSha
  );
}

export function formatSpawnReviewer(pr: LocalPr): string {
  return [
    `PR Genie: local PR ${pr.id} ("${pr.title}") on ${pr.headRef} is ready.`,
    'That is the review request. add_comment role=agent "Review requested." if you have not already. Do not git push.',
    "You are the implementor. Do not review this loop yourself. Do not claim_review. Do not Task a reviewer.",
    "Review is steward-only: /steward Tasks a /review leaf. If no steward is driving this loop, tell the user to run /steward — do not DIY a twin reviewer.",
  ].join("\n");
}

export async function markReviewRequested(cwd: string, id: string): Promise<LocalPr> {
  return withPrLock(cwd, id, async (pr) => {
    await applyHeadRefresh(cwd, pr);
    pr.reviewRequestedSha = pr.headSha;
    pr.updatedAt = nowIso();
  });
}

/** Record that the implementor chat was told to spawn a reviewer for this HEAD. */
export async function markReviewerNotified(cwd: string, id: string): Promise<LocalPr> {
  return withPrLock(cwd, id, async (pr) => {
    await applyHeadRefresh(cwd, pr);
    pr.reviewerNotifiedSha = pr.headSha;
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
    pr.readyCi = normalizeReadyCi(pr.readyCi);
    const now = nowIso();
    const author = options.author?.trim() || (await userName(cwd));

    // RAD-97: upsert a single Review-requested root per HEAD sha.
    if (role === "agent" && isReviewRequestBody(text) && !options.replyTo) {
      await applyHeadRefresh(cwd, pr);
      upsertReviewRequestedComment(pr, now, author, pr.headSha, newId("c"));
      pr.updatedAt = now;
      await writePr(cwd, pr);
      pr.worktreePath = resolved.worktreePath;
      return pr;
    }

    // RAD-97: "CI skipped: <reason>" stamps forSha and readyCi for this tip only.
    const skipReason = role === "agent" ? parseCiSkipReason(text) : null;
    if (skipReason && !options.replyTo) {
      await applyHeadRefresh(cwd, pr);
      pr.readyCi = readyCiFromSkipReason(pr.headSha, skipReason, now);
    }

    const comment: LocalPrComment = {
      id: newId("c"),
      body: text,
      createdAt: now,
      author,
      role,
      status: role === "agent" ? "resolved" : "open",
    };
    if (skipReason && !options.replyTo) {
      comment.forSha = pr.headSha;
    }
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
    } else if (role === "agent" && !isReviewRequestBody(text) && !skipReason) {
      const parent = lastFinding(pr);
      if (parent) comment.replyTo = parent.id;
    }
    pr.comments.push(comment);
    if (!isArchivedPr(pr) && comment.status === "open") {
      // Human findings always wake the implementor. Reviewer findings normally stay on
      // ready / review_interrupted until complete_review; if the loop is already reviewed,
      // a new finding must flip to changes_requested or the implementor inbox never sees it.
      if (role === "human" || (role === "reviewer" && pr.status === "reviewed")) {
        pr.status = "changes_requested";
      }
    }
    pr.updatedAt = comment.createdAt;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return pr;
  });
}

/** Edit an open finding's body (human or reviewer root comments only). */
export async function editLocalPrComment(
  cwd: string,
  id: string,
  commentId: string,
  body: string,
): Promise<LocalPr> {
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
    pr.updatedAt = nowIso();
  });
}

/** Delete an open finding and replies that target it. */
export async function deleteLocalPrComment(
  cwd: string,
  id: string,
  commentId: string,
): Promise<LocalPr> {
  const needle = commentId.trim();
  if (!needle) throw new Error("Comment id is empty");
  return withPrLock(cwd, id, async (pr) => {
    if (isArchivedPr(pr)) throw new Error(`Loop ${pr.id} is archived.`);
    const target = pr.comments.find((c) => c.id === needle || c.id.startsWith(needle));
    if (!target) throw new Error(`Comment not found: ${commentId}`);
    if (!isFindingComment(target) || target.status !== "open") {
      throw new Error("Only open findings can be deleted");
    }
    const drop = new Set<string>([target.id]);
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
    pr.updatedAt = nowIso();
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

export type CompleteLocalPrReviewResult = LocalPr & {
  /** True when HEAD moved after Review requested (reviewRequestedSha set and differs). */
  headDrift: boolean;
  reviewedAgainstSha: string | null;
};

export async function completeLocalPrReview(
  cwd: string,
  id: string,
  options: { author?: string; body?: string; allowDrift?: boolean } = {},
): Promise<CompleteLocalPrReviewResult> {
  const resolved = await getLocalPr(cwd, id);
  const dir = await prsDir(cwd);
  const file = prFile(dir, resolved.id);
  return withFileLock(file, async () => {
    const pr = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
    pr.comments = (pr.comments ?? []).map(normalizeComment);
    const reviewedAgainstSha = pr.reviewRequestedSha ?? null;
    await applyHeadRefresh(cwd, pr);
    const headDrift = Boolean(reviewedAgainstSha && reviewedAgainstSha !== pr.headSha);
    if (headDrift && !options.allowDrift) {
      throw new Error(
        `HEAD moved since Review requested (${reviewedAgainstSha?.slice(0, 8)} → ${pr.headSha.slice(0, 8)}). Re-diff and file any new findings while status is still ready, then complete-review again. Use --force / allowDrift only to finalize on purpose.`,
      );
    }
    const open = pendingReviewComments(pr);
    const now = nowIso();
    const author = options.author?.trim() || (await userName(cwd));
    const resolvedComments: LocalPrComment[] = [];
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
    const handedToImplementor = open.length > 0;
    pr.comments.push({
      id: newId("c"),
      body: (
        options.body?.trim() ||
        (handedToImplementor
          ? "Review complete. Findings are ready for the implementor."
          : "Review cleared. Steward will run the export gate.")
      ).trim(),
      createdAt: now,
      author,
      role: "reviewer",
      status: "resolved",
    });
    if (!isArchivedPr(pr)) {
      pr.status = handedToImplementor ? "changes_requested" : "reviewed";
      if (pr.status === "reviewed") pr.exportGate = pendingExportGate(pr.headSha);
    }
    pr.updatedAt = now;
    await writePr(cwd, pr);
    pr.worktreePath = resolved.worktreePath;
    return { ...pr, headDrift, reviewedAgainstSha };
  });
}

export async function getLocalPrDiff(
  cwd: string,
  id: string,
  options: { stat?: boolean; maxBytes?: number; paths?: string[] } = {},
): Promise<string> {
  const pr = await getLocalPr(cwd, id);
  const args = options.stat
    ? ["diff", "--stat", `${pr.baseSha}...${pr.headSha}`]
    : ["diff", `${pr.baseSha}...${pr.headSha}`];
  if (options.paths?.length) {
    args.push("--", ...options.paths);
  }
  const { stdout } = await git(cwd, args);
  const max = options.maxBytes ?? 200_000;
  if (stdout.length > max) {
    return `${stdout.slice(0, max)}\n\n... truncated (${stdout.length} bytes) ...`;
  }
  return stdout;
}

/** Permanently remove a loop packet, its refs, and any sibling worktree. */
export async function deleteLocalPr(
  cwd: string,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const pr = await getLocalPr(cwd, id);
  await releaseArchivedLoop(cwd, pr);
  const dir = await prsDir(cwd);
  const file = prFile(dir, pr.id);
  await withFileLock(file, async () => {
    await unlink(file).catch(() => undefined);
  });
  await git(cwd, ["update-ref", "-d", `refs/local-pr/${pr.id}/head`], { allowFail: true });
  await git(cwd, ["update-ref", "-d", `refs/local-pr/${pr.id}/base`], { allowFail: true });
  return { id: pr.id, deleted: true };
}

/** Bring an archived loop back as changes_requested and recreate its worktree. */
export async function reopenLocalPr(cwd: string, id: string): Promise<LocalPr> {
  const updated = await withPrLock(cwd, id, async (pr) => {
    if (!isArchivedPr(pr)) {
      throw new Error(`Loop ${pr.id} is not archived; only approved loops can be reopened.`);
    }
    pr.status = "changes_requested";
    pr.reviewRequestedSha = null;
    pr.reviewerNotifiedSha = null;
    await applyHeadRefresh(cwd, pr);
    pr.updatedAt = nowIso();
  });
  updated.worktreePath = await ensureWorktreeForLoop(cwd, updated, {
    staleLoopIds: (await listLocalPrs(cwd))
      .filter((other) => other.id !== updated.id && isArchivedPr(other))
      .map((other) => other.id),
    liveLoopIds: (await listLocalPrs(cwd))
      .filter((other) => !isArchivedPr(other))
      .map((other) => other.id),
  });
  return updated;
}

export async function getLocalPrNameStatus(
  cwd: string,
  id: string,
): Promise<{ status: string; path: string }[]> {
  // Refresh headSha before diffing — stale packet SHAs (still equal to base after
  // create, or behind new commits) yield an empty name-status and false full-suite CI.
  const pr = await refreshLocalPrHead(cwd, id);
  const { stdout } = await git(cwd, ["diff", "--name-status", `${pr.baseSha}...${pr.headSha}`]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

export async function refreshLocalPrHead(cwd: string, id: string): Promise<LocalPr> {
  return withPrLock(cwd, id, (pr) => applyHeadRefresh(cwd, pr));
}

export async function hasCommitsAheadOfBase(cwd: string, baseRef?: string): Promise<boolean> {
  const base = baseRef ?? (await detectDefaultBase(cwd));
  const ahead = await git(cwd, ["rev-list", "--count", `${base}..HEAD`], {
    allowFail: true,
  });
  if (ahead.code !== 0) return false;
  return Number(ahead.stdout.trim()) > 0;
}

export interface AttachLocalPrInput {
  /** GitHub PR number, URL, or remote branch name */
  source: string;
  /** Override base branch (default: detected from PR or repo default) */
  base?: string;
  /** Override title (default: from PR metadata) */
  title?: string;
  /** Override body (default: from PR metadata) */
  body?: string;
  /** Source metadata for tracking */
  prSource?: LocalPrSource;
}

export async function attachLocalPr(cwd: string, input: AttachLocalPrInput): Promise<LocalPr> {
  const root = await requireGitRoot(cwd);
  await assertNoDirtyPluginBuildArtifacts(root);
  const { runGh } = await import("./github-ops.js");

  // Parse input to determine if it's a PR number/URL or branch
  const source = input.source.trim();
  let headRef: string;
  let baseRef: string;
  let title: string;
  let body: string;
  let headSha: string;
  let baseSha: string;

  // Try to parse as GitHub PR (number or URL)
  const prNumberMatch = source.match(/^#?(\d+)$/) ?? source.match(/\/pull\/(\d+)/);

  if (prNumberMatch) {
    // Fetch PR metadata from GitHub
    const prNumber = prNumberMatch[1];
    const result = await runGh(
      ["pr", "view", prNumber, "--json", "title,body,headRefName,baseRefName,headRefOid,state"],
      { cwd },
    );

    if (result.code !== 0) {
      throw new Error(
        `Failed to fetch GitHub PR #${prNumber}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const prData = JSON.parse(result.stdout) as {
      title: string;
      body: string;
      headRefName: string;
      baseRefName: string;
      headRefOid: string;
      state: string;
    };

    if (prData.state.toUpperCase() === "MERGED") {
      throw new Error(
        `GitHub PR #${prNumber} is already merged. Cannot attach merged PRs to new lanes.`,
      );
    }

    headRef = prData.headRefName;
    baseRef = input.base ?? prData.baseRefName;
    title = input.title ?? prData.title;
    body = input.body ?? prData.body;

    // Fetch the remote branch to get the latest commit
    const fetchResult = await git(root, ["fetch", "origin", headRef], { allowFail: true });
    if (fetchResult.code !== 0) {
      throw new Error(
        `Failed to fetch remote branch ${headRef}: ${fetchResult.stderr.trim() || "git fetch failed"}`,
      );
    }

    const remoteRef = `origin/${headRef}`;
    const shaResult = await git(root, ["rev-parse", "--verify", remoteRef], { allowFail: true });
    if (shaResult.code !== 0) {
      throw new Error(`Cannot resolve remote branch: ${remoteRef}`);
    }
    headSha = shaResult.stdout.trim();
  } else {
    // Treat as branch name
    headRef = source.replace(/^origin\//, "");

    // Fetch the branch
    const fetchResult = await git(root, ["fetch", "origin", headRef], { allowFail: true });
    if (fetchResult.code !== 0) {
      throw new Error(
        `Failed to fetch remote branch ${headRef}: ${fetchResult.stderr.trim() || "git fetch failed"}`,
      );
    }

    const remoteRef = `origin/${headRef}`;
    const shaResult = await git(root, ["rev-parse", "--verify", remoteRef], { allowFail: true });
    if (shaResult.code !== 0) {
      throw new Error(`Cannot resolve remote branch: ${remoteRef}`);
    }
    headSha = shaResult.stdout.trim();

    // Use provided base or detect default
    const detectedBase = input.base ?? (await detectDefaultBase(cwd));
    // Normalize base to remove origin/ prefix if present
    baseRef = detectedBase.replace(/^origin\//, "");

    // Try to get PR info if this branch has an open PR
    const prCheckResult = await runGh(["pr", "view", headRef, "--json", "title,body,state"], {
      cwd,
    });

    if (prCheckResult.code === 0) {
      try {
        const prData = JSON.parse(prCheckResult.stdout) as {
          title: string;
          body: string;
          state: string;
        };

        // Reject if the PR is already merged
        if (prData.state.toUpperCase() === "MERGED") {
          throw new Error(
            `Branch ${headRef} has a merged GitHub PR. Cannot attach merged PRs to new lanes.`,
          );
        }

        title = input.title ?? prData.title;
        body = input.body ?? prData.body;
      } catch (err) {
        // If it's our merged-PR error, re-throw it
        if (err instanceof Error && err.message.includes("merged GitHub PR")) {
          throw err;
        }
        // Otherwise, fallback to branch-based title
        title =
          input.title ?? (await shortLogSubject(cwd, headSha).catch(() => `Attached ${headRef}`));
        body = input.body ?? "";
      }
    } else {
      // No PR found, use branch-based title
      title =
        input.title ?? (await shortLogSubject(cwd, headSha).catch(() => `Attached ${headRef}`));
      body = input.body ?? "";
    }
  }

  // Resolve base SHA
  const baseResolved = await git(root, ["rev-parse", "--verify", baseRef], { allowFail: true });
  if (baseResolved.code !== 0) {
    throw new Error(`Cannot resolve base branch: ${baseRef}`);
  }
  // eslint-disable-next-line prefer-const
  baseSha = baseResolved.stdout.trim();

  // Check if a lane for this headRef already exists
  const existing = (await listLocalPrs(root)).find(
    (pr) => pr.headRef === headRef && !isArchivedPr(pr),
  );
  if (existing) {
    throw new Error(
      `A lane for branch ${headRef} already exists (${existing.id}). Use update or refresh instead.`,
    );
  }

  // Create the lane
  const id = newId("lp");
  const createdAt = nowIso();
  const pr: LocalPr = {
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
    reviewerNotifiedSha: null,
    readyCi: null,
  };

  await writePr(root, pr);

  const others = await listLocalPrs(root);
  pr.worktreePath = await ensureWorktreeForLoop(root, pr, {
    staleLoopIds: others
      .filter((other) => other.id !== pr.id && isArchivedPr(other))
      .map((other) => other.id),
    liveLoopIds: others.filter((other) => !isArchivedPr(other)).map((other) => other.id),
  });

  await resumeWatchForNextLoop(root);
  return pr;
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
    : (await listLocalPrs(cwd)).find((pr) => pr.headRef === headRef && !isArchivedPr(pr));
  if (existing) {
    const updated = await withPrLock(cwd, existing.id, async (pr) => {
      if (input.source) pr.source = input.source;
      if (input.title?.trim()) pr.title = input.title.trim();
      if (input.body?.trim()) pr.body = input.body.trim();
      // applyHeadRefresh invalidates reviewed → ready when tip moved (RAD-126).
      await applyHeadRefresh(cwd, pr);
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
