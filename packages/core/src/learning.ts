import { findGitRoot } from "./git.js";
import { listLocalPrs } from "./prs.js";
import { listSessions } from "./sessions.js";

export interface LearningSummary {
  /** Total review comments analyzed (human + reviewer). */
  totalComments: number;
  /** Total sessions analyzed. */
  totalSessions: number;
  /** Top comment keywords/phrases with frequency. */
  topKeywords: Array<{ keyword: string; count: number }>;
  /** Most common comment paths (files). */
  topFiles: Array<{ path: string; count: number }>;
  /** Common comment patterns. */
  patterns: Array<{ pattern: string; examples: string[]; count: number }>;
  /** Session hooks summary. */
  sessionHooks: Array<{ hook: string; count: number }>;
}

/**
 * Extract meaningful keywords from text (exclude common English stop words).
 * Returns 2-5 word phrases and significant single words.
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
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
    "yes",
  ]);

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = normalized.split(" ").filter((w) => w.length > 2 && !stopWords.has(w));

  const keywords: string[] = [];

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

/**
 * Identify common patterns in comment text.
 * Looks for phrases that indicate common issues.
 */
function identifyPattern(text: string): string | null {
  const lower = text.toLowerCase();

  const patterns = [
    { regex: /\b(missing|need[s]?|add|include)\s+test[s]?\b/i, label: "missing tests" },
    {
      regex: /\b(missing|need[s]?)\s+(error|exception)\s+handling\b/i,
      label: "missing error handling",
    },
    { regex: /\bnull\s+(check|pointer|reference)\b/i, label: "null safety" },
    { regex: /\b(type|typing)\s+(error|issue|problem)\b/i, label: "type issues" },
    { regex: /\b(typo|spelling|misspell)/i, label: "typos" },
    { regex: /\b(locali[zs]ation|locali[zs]e|hardcoded\s+string)/i, label: "localization" },
    { regex: /\b(duplicate|duplicated|repeated)\s+code\b/i, label: "code duplication" },
    {
      regex: /\b(extract|refactor|separate)\s+(method|function|component|class)\b/i,
      label: "refactoring needed",
    },
    { regex: /\b(const|constant)\s+(widget|component|class)\b/i, label: "const widget pattern" },
    { regex: /\b(performance|optimi[zs]e|slow|inefficient)\b/i, label: "performance" },
    { regex: /\b(security|vulnerability|unsafe)\b/i, label: "security" },
    { regex: /\b(documentation|document|comment|explain)\b/i, label: "documentation" },
    { regex: /\b(naming|name|rename)\b/i, label: "naming" },
    { regex: /\b(format|formatting|style)\b/i, label: "code style" },
    { regex: /\b(edge case|boundary|corner case)\b/i, label: "edge cases" },
  ];

  for (const { regex, label } of patterns) {
    if (regex.test(lower)) return label;
  }

  return null;
}

/**
 * Generate a learning digest from session history and PR comments.
 * Analyzes patterns in reviewer/human comments to show what keeps getting flagged.
 */
export async function generateLearningDigest(
  cwd: string,
  options: {
    /** Max sessions to analyze (default 100). */
    sessionLimit?: number;
    /** Only analyze comments since this ISO timestamp. */
    since?: string;
  } = {},
): Promise<LearningSummary> {
  const root = await findGitRoot(cwd);
  if (!root) {
    return {
      totalComments: 0,
      totalSessions: 0,
      topKeywords: [],
      topFiles: [],
      patterns: [],
      sessionHooks: [],
    };
  }

  const sessionLimit = options.sessionLimit ?? 100;
  const sessions = await listSessions(root, { limit: sessionLimit, since: options.since });

  const prs = await listLocalPrs(root);

  const keywordCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  const patternCounts = new Map<string, { count: number; examples: string[] }>();
  const sessionHookCounts = new Map<string, number>();

  let totalComments = 0;

  for (const pr of prs) {
    for (const comment of pr.comments ?? []) {
      if (comment.role !== "human" && comment.role !== "reviewer") continue;

      if (options.since) {
        const commentDate = new Date(comment.createdAt).getTime();
        const sinceDate = new Date(options.since).getTime();
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

  const topKeywords = Array.from(keywordCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([keyword, count]) => ({ keyword, count }));

  const topFiles = Array.from(fileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));

  const patterns = Array.from(patternCounts.entries())
    .filter(([, data]) => data.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([pattern, data]) => ({
      pattern,
      examples: data.examples,
      count: data.count,
    }));

  const sessionHooks = Array.from(sessionHookCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([hook, count]) => ({ hook, count }));

  return {
    totalComments,
    totalSessions: sessions.length,
    topKeywords,
    topFiles,
    patterns,
    sessionHooks,
  };
}

/**
 * Format learning digest as human-readable text.
 */
export function formatLearningDigest(summary: LearningSummary): string {
  const lines: string[] = [];

  lines.push("# PR Genie Learning Digest");
  lines.push("");
  lines.push(
    `Analyzed ${summary.totalComments} review comment(s) and ${summary.totalSessions} session(s).`,
  );
  lines.push("");

  if (summary.patterns.length > 0) {
    lines.push("## What Keeps Getting Flagged");
    lines.push("");
    for (const { pattern, count, examples } of summary.patterns) {
      lines.push(`**${pattern}** — flagged ${count} time(s)`);
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
    for (const { path, count } of summary.topFiles) {
      lines.push(`- \`${path}\` — ${count} comment(s)`);
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

  if (
    summary.patterns.length === 0 &&
    summary.topFiles.length === 0 &&
    summary.topKeywords.length === 0
  ) {
    lines.push(
      "No recurring patterns found. Either this is the first review or patterns haven't emerged yet.",
    );
  }

  return lines.join("\n").trim();
}
