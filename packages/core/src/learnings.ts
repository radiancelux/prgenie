import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { consoleDir, parseJsonObject, writeJsonFile } from "./store.js";
import type {
  Learning,
  LocalPr,
  LocalPrComment,
  PreflightIssue,
  PreflightResult,
} from "./types.js";
import { isFindingComment } from "./prs.js";
import { getLocalPrDiff } from "./prs.js";

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function learningsFile(cwd: string): Promise<string> {
  const dir = await consoleDir(cwd);
  return path.join(dir, "learnings.json");
}

interface LearningsStore {
  learnings: Learning[];
  version: number;
}

async function readLearnings(cwd: string): Promise<LearningsStore> {
  const file = await learningsFile(cwd);
  try {
    const raw = await readFile(file, "utf8");
    const store = parseJsonObject<LearningsStore>(raw);
    return {
      learnings: store.learnings ?? [],
      version: store.version ?? 1,
    };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ENOENT") {
      return { learnings: [], version: 1 };
    }
    throw err;
  }
}

async function writeLearnings(cwd: string, store: LearningsStore): Promise<void> {
  const file = await learningsFile(cwd);
  await writeJsonFile(file, store);
}

export async function extractLearningsFromResolvedComments(
  pr: LocalPr,
  comments: LocalPrComment[],
): Promise<Learning[]> {
  const learnings: Learning[] = [];
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
      category: inferCategory(comment),
    });
  }

  return learnings;
}

function extractPattern(body: string): string | null {
  const patternMatch =
    body.match(/pattern[:\s]+(.+?)(?:\n|$)/i) ||
    body.match(/issue[:\s]+(.+?)(?:\n|$)/i) ||
    body.match(/problem[:\s]+(.+?)(?:\n|$)/i);

  if (patternMatch) return patternMatch[1].trim();

  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    return lines[0].trim().slice(0, 200);
  }

  return null;
}

function extractGuidance(body: string): string | null {
  const guidanceMatch =
    body.match(/(?:fix|solution|should|must|instead)[:\s]+(.+?)(?:\n\n|$)/is) ||
    body.match(/guidance[:\s]+(.+?)(?:\n\n|$)/is);

  if (guidanceMatch) return guidanceMatch[1].trim();

  return body.trim().slice(0, 500);
}

function inferCategory(comment: LocalPrComment): string | undefined {
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
  return undefined;
}

export async function addLearnings(cwd: string, learnings: Learning[]): Promise<void> {
  if (learnings.length === 0) return;

  const store = await readLearnings(cwd);
  store.learnings.push(...learnings);
  await writeLearnings(cwd, store);
}

export async function listLearnings(
  cwd: string,
  options: { disabled?: boolean; category?: string } = {},
): Promise<Learning[]> {
  const store = await readLearnings(cwd);
  let learnings = store.learnings;

  if (options.disabled !== undefined) {
    learnings = learnings.filter((l) => l.disabled === options.disabled);
  }

  if (options.category) {
    learnings = learnings.filter((l) => l.category === options.category);
  }

  return learnings.sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
}

export async function getLearning(cwd: string, id: string): Promise<Learning | null> {
  const store = await readLearnings(cwd);
  return store.learnings.find((l) => l.id === id || l.id.startsWith(id)) ?? null;
}

export async function disableLearning(cwd: string, id: string): Promise<Learning> {
  const store = await readLearnings(cwd);
  const learning = store.learnings.find((l) => l.id === id || l.id.startsWith(id));
  if (!learning) throw new Error(`Learning not found: ${id}`);

  learning.disabled = true;
  await writeLearnings(cwd, store);
  return learning;
}

export async function enableLearning(cwd: string, id: string): Promise<Learning> {
  const store = await readLearnings(cwd);
  const learning = store.learnings.find((l) => l.id === id || l.id.startsWith(id));
  if (!learning) throw new Error(`Learning not found: ${id}`);

  learning.disabled = false;
  await writeLearnings(cwd, store);
  return learning;
}

export async function deleteLearning(
  cwd: string,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const store = await readLearnings(cwd);
  const index = store.learnings.findIndex((l) => l.id === id || l.id.startsWith(id));
  if (index === -1) throw new Error(`Learning not found: ${id}`);

  const learning = store.learnings[index];
  store.learnings.splice(index, 1);
  await writeLearnings(cwd, store);
  return { id: learning.id, deleted: true };
}

export async function runPreflight(cwd: string, pr: LocalPr): Promise<PreflightResult> {
  const learnings = await listLearnings(cwd, { disabled: false });
  const issues: PreflightIssue[] = [];

  const diff = await getLocalPrDiff(cwd, pr.id, { maxBytes: 500_000 });

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
        matchedIn: "title",
      });
      continue;
    }

    if (bodyLower.includes(patternLower)) {
      issues.push({
        learningId: learning.id,
        pattern: learning.pattern,
        guidance: learning.guidance,
        matchedIn: "body",
      });
      continue;
    }

    if (diffLower.includes(patternLower)) {
      issues.push({
        learningId: learning.id,
        pattern: learning.pattern,
        guidance: learning.guidance,
        matchedIn: "diff",
        path: learning.path,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
