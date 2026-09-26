import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  buildReviewGuidanceExcerpt,
  discoverReviewGuidanceSource,
  extractClaudeReviewSection,
  hashGuidanceContent,
  loadReviewGuidanceSnapshot,
  normalizeGuidanceText,
  parseReviewGuidanceMeta,
  REVIEW_GUIDANCE_CHARS_PER_TOKEN,
  REVIEW_GUIDANCE_TOKEN_BUDGET,
  truncateGuidanceExcerpt,
} from "./repo-guidance.js";

let repo = "";

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-guidance-"));
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("discovery prefers .prgenie/review.md over cursor rules and CLAUDE.md", async () => {
  await mkdir(path.join(repo, ".prgenie"), { recursive: true });
  await mkdir(path.join(repo, ".cursor", "rules"), { recursive: true });
  await writeFile(path.join(repo, ".prgenie", "review.md"), "# Canonical\n\n- Rule A\n");
  await writeFile(path.join(repo, ".cursor", "rules", "review-ui.mdc"), "- Cursor rule\n");
  await writeFile(path.join(repo, "CLAUDE.md"), "## Review\n\n- Claude rule\n");

  const source = await discoverReviewGuidanceSource(repo);
  assert.equal(source?.kind, "canonical");
  assert.equal(source?.path, ".prgenie/review.md");
  assert.match(source?.content ?? "", /Rule A/);
});

test("discovery falls back to .cursor/rules/*review*", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-guidance-cursor-"));
  try {
    await mkdir(path.join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "rules", "my-review.mdc"), "- UI libs\n");
    await writeFile(path.join(root, "CLAUDE.md"), "## Review\n\n- Claude only\n");

    const source = await discoverReviewGuidanceSource(root);
    assert.equal(source?.kind, "cursor-rule");
    assert.match(source?.path ?? "", /my-review\.mdc/);
    assert.match(source?.content ?? "", /UI libs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery falls back to CLAUDE.md Review section", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-guidance-claude-"));
  try {
    await writeFile(
      path.join(root, "CLAUDE.md"),
      "# Project\n\n## Review\n\n- Always test auth\n\n## Other\n\nnope\n",
    );
    const source = await discoverReviewGuidanceSource(root);
    assert.equal(source?.kind, "claude-md");
    assert.equal(source?.path, "CLAUDE.md#Review");
    assert.match(source?.content ?? "", /Always test auth/);
    assert.doesNotMatch(source?.content ?? "", /nope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing guidance returns null without error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-guidance-empty-"));
  try {
    assert.equal(await discoverReviewGuidanceSource(root), null);
    assert.equal(await loadReviewGuidanceSnapshot(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractClaudeReviewSection parses Review heading", () => {
  const section = extractClaudeReviewSection("## Review\n\n- one\n\n## Next\n\n- two\n");
  assert.match(section ?? "", /one/);
  assert.doesNotMatch(section ?? "", /two/);
});

test("parseReviewGuidanceMeta reads zero-tolerance and stack categories", () => {
  const meta = parseReviewGuidanceMeta(
    "## Zero-tolerance\n\n- secrets in logs\n- raw SQL injection\n\n## Stack\n\n- React hooks\n- Tailwind only\n",
  );
  assert.deepEqual(meta.zeroToleranceCategories, ["secrets in logs", "raw SQL injection"]);
  assert.deepEqual(meta.stackCategories, ["React hooks", "Tailwind only"]);
});

test("truncation respects token budget", () => {
  const long = "- rule\n".repeat(5000);
  const excerpt = truncateGuidanceExcerpt(long, 100);
  assert.ok(excerpt.length <= 100 * REVIEW_GUIDANCE_CHARS_PER_TOKEN + 80);
  assert.match(excerpt, /truncated/);
});

test("buildReviewGuidanceExcerpt stays within budget", () => {
  const source = {
    kind: "canonical" as const,
    path: ".prgenie/review.md",
    content: "- " + "x".repeat(20_000),
  };
  const excerpt = buildReviewGuidanceExcerpt(source);
  assert.ok(excerpt.length <= REVIEW_GUIDANCE_TOKEN_BUDGET * REVIEW_GUIDANCE_CHARS_PER_TOKEN + 120);
});

test("hash is stable across CRLF and LF", () => {
  const lf = "line one\nline two\n";
  const crlf = "line one\r\nline two\r\n";
  assert.equal(hashGuidanceContent(lf), hashGuidanceContent(crlf));
  assert.equal(normalizeGuidanceText(crlf), lf);
});

test("loadReviewGuidanceSnapshot records hash in snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-guidance-hash-"));
  try {
    await mkdir(path.join(root, ".prgenie"), { recursive: true });
    await writeFile(path.join(root, ".prgenie", "review.md"), "- Ship safe\n");
    const snap = await loadReviewGuidanceSnapshot(root);
    assert.ok(snap?.contentHash);
    assert.equal(snap?.contentHash, hashGuidanceContent("- Ship safe"));
    assert.ok(snap?.excerpt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows-style paths in source discovery use forward slashes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prgenie-guidance-win-"));
  try {
    await mkdir(path.join(root, ".prgenie"), { recursive: true });
    await writeFile(path.join(root, ".prgenie", "review.md"), "- Win ok\r\n");
    const snap = await loadReviewGuidanceSnapshot(root);
    assert.equal(snap?.sourcePath, ".prgenie/review.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
