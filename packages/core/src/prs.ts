import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, gitText, requireGitRoot } from "./git.js";
import { prFile, prsDir } from "./store.js";
import {
  currentBranch,
  detectDefaultBase,
  listWorktrees,
  shortLogSubject,
  userName,
  worktreeForBranch,
} from "./worktrees.js";
import type {
  CaptureResult,
  CreateLocalPrInput,
  LocalPr,
  LocalPrComment,
  LocalPrStatus,
} from "./types.js";
import { STATUSES } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function writePr(cwd: string, pr: LocalPr): Promise<void> {
  const dir = await prsDir(cwd);
  await writeFile(prFile(dir, pr.id), JSON.stringify(pr, null, 2), "utf8");
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
    const pr = JSON.parse(raw) as LocalPr;
    pr.source = pr.source ?? null;
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
  const trees = await listWorktrees(root);
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
    worktreePath: worktreeForBranch(trees, headRef),
    comments: [],
    source: input.source ?? { kind: "cli" },
    createdAt,
    updatedAt: createdAt,
  };
  await writePr(root, pr);
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

export async function addLocalPrComment(
  cwd: string,
  id: string,
  body: string,
): Promise<LocalPr> {
  const text = body.trim();
  if (!text) throw new Error("Comment body is empty");
  const pr = await getLocalPr(cwd, id);
  const comment: LocalPrComment = {
    id: newId("c"),
    body: text,
    createdAt: nowIso(),
    author: await userName(cwd),
  };
  pr.comments.push(comment);
  if (pr.status === "ready" || pr.status === "approved") {
    pr.status = "changes_requested";
  }
  pr.updatedAt = comment.createdAt;
  await writePr(cwd, pr);
  return pr;
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
  const sha = await gitText(cwd, ["rev-parse", pr.headRef]);
  pr.headSha = sha;
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
    return { action: "updated", pr: updated };
  }
  const pr = await createLocalPr(cwd, input);
  return { action: "created", pr };
}
