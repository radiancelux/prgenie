import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewGuidanceSnapshot } from "./types.js";

/** Approximate token budget for reviewer brief excerpt (~1–2k tokens). */
export const REVIEW_GUIDANCE_TOKEN_BUDGET = 1800;

/** Rough chars-per-token for truncation (English prose). */
export const REVIEW_GUIDANCE_CHARS_PER_TOKEN = 4;

export const REVIEW_GUIDANCE_CANONICAL = ".prgenie/review.md";
export const REVIEW_GUIDANCE_PROCESS_BAR = "packages/plugin/skills/review/process-bar.md";

export type ReviewGuidanceSourceKind = "canonical" | "cursor-rule" | "claude-md";

export interface ReviewGuidanceSource {
  kind: ReviewGuidanceSourceKind;
  /** Repo-relative path with forward slashes. */
  path: string;
  content: string;
}

export interface ReviewGuidanceMeta {
  zeroToleranceCategories: string[];
  stackCategories: string[];
}

export type { ReviewGuidanceSnapshot };

function posixRel(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

export function normalizeGuidanceText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function hashGuidanceContent(content: string): string {
  const normalized = normalizeGuidanceText(content);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Extract `## Review` section from CLAUDE.md (until next `##` heading). */
export function extractClaudeReviewSection(content: string): string | null {
  const normalized = normalizeGuidanceText(content);
  const match = normalized.match(/(?:^|\n)##\s+Review\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (!match) return null;
  const body = match[1].trim();
  return body.length > 0 ? body : null;
}

async function discoverCursorReviewRules(repoRoot: string): Promise<ReviewGuidanceSource | null> {
  const rulesDir = path.join(repoRoot, ".cursor", "rules");
  let names: string[];
  try {
    names = (await readdir(rulesDir)).filter((name) => /review/i.test(name));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  names.sort((a, b) => a.localeCompare(b));
  const chunks: string[] = [];
  const relPaths: string[] = [];
  for (const name of names) {
    const abs = path.join(rulesDir, name);
    const text = await readTextFile(abs);
    if (!text?.trim()) continue;
    relPaths.push(posixRel(repoRoot, abs));
    chunks.push(`# ${posixRel(repoRoot, abs)}\n\n${text.trim()}`);
  }
  if (chunks.length === 0) return null;
  return {
    kind: "cursor-rule",
    path: relPaths.join(", "),
    content: chunks.join("\n\n---\n\n"),
  };
}

/**
 * Discovery order (RAD-102):
 * 1. `.prgenie/review.md`
 * 2. `.cursor/rules/*review*`
 * 3. Review section of `CLAUDE.md`
 * Missing → null (generic process bar only).
 */
export async function discoverReviewGuidanceSource(
  repoRoot: string,
): Promise<ReviewGuidanceSource | null> {
  const canonical = path.join(repoRoot, ...REVIEW_GUIDANCE_CANONICAL.split("/"));
  if (await fileExists(canonical)) {
    const content = await readTextFile(canonical);
    if (content?.trim()) {
      return {
        kind: "canonical",
        path: REVIEW_GUIDANCE_CANONICAL,
        content: content.trim(),
      };
    }
  }

  const cursor = await discoverCursorReviewRules(repoRoot);
  if (cursor) return cursor;

  const claudePath = path.join(repoRoot, "CLAUDE.md");
  const claude = await readTextFile(claudePath);
  if (claude) {
    const section = extractClaudeReviewSection(claude);
    if (section) {
      return { kind: "claude-md", path: "CLAUDE.md#Review", content: section };
    }
  }

  return null;
}

/** Pull bullet/numbered rule lines for excerpt (top N). */
export function extractTopRules(content: string, maxRules = 12): string[] {
  const lines = normalizeGuidanceText(content).split("\n");
  const rules: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      rules.push(trimmed.replace(/^[-*]\s+/, "- ").replace(/^\d+[.)]\s+/, "- "));
      if (rules.length >= maxRules) break;
    }
  }
  return rules;
}

function extractSectionBullets(content: string, headingPattern: string): string[] {
  const normalized = normalizeGuidanceText(content);
  const match = normalized.match(
    new RegExp(`(?:^|\\n)##\\s+${headingPattern}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
  );
  if (!match) return [];
  const body = match[1] ?? "";
  return extractTopRules(body, 50).map((line) => line.replace(/^-\s+/, "").trim());
}

/** Zero-tolerance / stack categories from review.md fill RAD-103 opt-in keys. */
export function parseReviewGuidanceMeta(content: string): ReviewGuidanceMeta {
  return {
    zeroToleranceCategories: extractSectionBullets(content, "zero[- ]?tolerance"),
    stackCategories: extractSectionBullets(content, "stack"),
  };
}

export function truncateGuidanceExcerpt(text: string, maxTokens = REVIEW_GUIDANCE_TOKEN_BUDGET): string {
  const maxChars = maxTokens * REVIEW_GUIDANCE_CHARS_PER_TOKEN;
  const normalized = normalizeGuidanceText(text).trim();
  if (normalized.length <= maxChars) return normalized;
  const cut = normalized.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  const trimmed = (lastBreak > maxChars * 0.7 ? cut.slice(0, lastBreak) : cut).trimEnd();
  return `${trimmed}\n\n… [truncated — read full file at source path]`;
}

export function buildReviewGuidanceExcerpt(source: ReviewGuidanceSource): string {
  const rules = extractTopRules(source.content);
  const meta = parseReviewGuidanceMeta(source.content);
  const lines = [
    `Source: \`${source.path}\` (${source.kind})`,
    "",
    "### Top rules",
    ...(rules.length > 0 ? rules : ["- (no bullet rules — read full source)"]),
  ];
  if (meta.zeroToleranceCategories.length > 0) {
    lines.push("", "### Zero-tolerance categories", ...meta.zeroToleranceCategories.map((c) => `- ${c}`));
  }
  if (meta.stackCategories.length > 0) {
    lines.push("", "### Stack categories", ...meta.stackCategories.map((c) => `- ${c}`));
  }
  return truncateGuidanceExcerpt(lines.join("\n"));
}

export async function loadReviewGuidanceSnapshot(
  repoRoot: string,
  now = new Date().toISOString(),
): Promise<ReviewGuidanceSnapshot | null> {
  const source = await discoverReviewGuidanceSource(repoRoot);
  if (!source) return null;
  const meta = parseReviewGuidanceMeta(source.content);
  return {
    sourcePath: source.path,
    sourceKind: source.kind,
    contentHash: hashGuidanceContent(source.content),
    recordedAt: now,
    excerpt: buildReviewGuidanceExcerpt(source),
    zeroToleranceCategories: meta.zeroToleranceCategories,
    stackCategories: meta.stackCategories,
  };
}

/** Reviewer Task brief block — truncated excerpt, not full dump. */
export function formatReviewerGuidanceBrief(snapshot: ReviewGuidanceSnapshot | null): string | null {
  if (!snapshot?.excerpt) return null;
  return [
    "## Repo review guidance (excerpt)",
    "",
    `Hash: \`${snapshot.contentHash}\`  Source: \`${snapshot.sourcePath}\``,
    "",
    snapshot.excerpt,
    "",
    `Apply with [process-bar.md](${REVIEW_GUIDANCE_PROCESS_BAR}). Read the full source at \`${snapshot.sourcePath}\` in the worktree when needed.`,
  ].join("\n");
}

/** Resolve repo root for guidance reads — prefer loop worktree over primary cwd. */
export function guidanceRepoRoot(cwd: string, worktreePath: string | null | undefined): string {
  return worktreePath?.trim() ? worktreePath : cwd;
}
