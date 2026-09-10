import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appendSession } from "./sessions.js";
import { createLocalPr, addLocalPrComment, getLocalPr } from "./prs.js";
import { generateLearningDigest, formatLearningDigest } from "./learning.js";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-learning-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("generateLearningDigest returns empty summary when no data", async () => {
  const summary = await generateLearningDigest(repo);
  assert.equal(summary.totalComments, 0);
  assert.equal(summary.totalSessions, 0);
  assert.equal(summary.topKeywords.length, 0);
  assert.equal(summary.topFiles.length, 0);
  assert.equal(summary.patterns.length, 0);
});

test("generateLearningDigest analyzes session hooks", async () => {
  await appendSession(repo, { hook: "subagentStop", status: "completed" });
  await appendSession(repo, { hook: "subagentStop", status: "completed" });
  await appendSession(repo, { hook: "sessionStart", status: "ok" });

  const summary = await generateLearningDigest(repo);
  assert.equal(summary.totalSessions, 3);
  assert.ok(summary.sessionHooks.some((h) => h.hook === "subagentStop" && h.count === 2));
  assert.ok(summary.sessionHooks.some((h) => h.hook === "sessionStart" && h.count === 1));
});

test("generateLearningDigest identifies common patterns in comments", async () => {
  git(["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "test.ts"), "export const foo = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "add test"]);

  const pr = await createLocalPr(repo, {
    title: "Test PR",
    body: "Test body",
    base: "main",
    head: "feature",
  });

  await addLocalPrComment(repo, pr.id, "Missing tests for this function", {
    role: "reviewer",
    author: "reviewer",
    path: "test.ts",
    line: 1,
  });

  await addLocalPrComment(repo, pr.id, "Need tests here", {
    role: "human",
    author: "human",
    path: "test.ts",
    line: 1,
  });

  await addLocalPrComment(repo, pr.id, "Missing error handling for edge case", {
    role: "reviewer",
    author: "reviewer",
    path: "test.ts",
    line: 1,
  });

  await addLocalPrComment(repo, pr.id, "Need error handling here too", {
    role: "human",
    author: "human",
    path: "test.ts",
    line: 2,
  });

  const summary = await generateLearningDigest(repo);
  assert.ok(summary.totalComments >= 4);

  const testPattern = summary.patterns.find((p) => p.pattern === "missing tests");
  assert.ok(testPattern, "Should identify 'missing tests' pattern");
  assert.equal(testPattern?.count, 2);

  const errorPattern = summary.patterns.find((p) => p.pattern === "missing error handling");
  assert.ok(errorPattern, "Should identify 'missing error handling' pattern");
  assert.ok(errorPattern && errorPattern.count >= 2);

  const fileComment = summary.topFiles.find((f) => f.path === "test.ts");
  assert.ok(fileComment, "Should track commented file");
  assert.ok(fileComment && fileComment.count >= 4);
});

test("generateLearningDigest extracts keywords", async () => {
  git(["checkout", "-b", "feature2"]);
  await writeFile(path.join(repo, "widget.ts"), "export class Widget {}\n");
  git(["add", "."]);
  git(["commit", "-m", "add widget"]);

  const pr = await createLocalPr(repo, {
    title: "Widget PR",
    body: "Add widget",
    base: "main",
    head: "feature2",
  });

  await addLocalPrComment(
    repo,
    pr.id,
    "Refactor this into a const widget class for better performance",
    {
      role: "reviewer",
      author: "reviewer",
      path: "widget.ts",
    },
  );

  await addLocalPrComment(repo, pr.id, "Extract method to separate class for reusability", {
    role: "reviewer",
    author: "reviewer",
    path: "widget.ts",
  });

  await addLocalPrComment(repo, pr.id, "Refactor the widget component pattern", {
    role: "human",
    author: "human",
    path: "widget.ts",
  });

  const summary = await generateLearningDigest(repo);
  assert.ok(summary.totalComments >= 3);

  const hasRefactorKeyword = summary.topKeywords.some(
    (k) => k.keyword.includes("refactor") && k.count >= 2,
  );
  assert.ok(hasRefactorKeyword, "Should extract refactoring keywords with count >= 2");
});

test("generateLearningDigest respects since parameter", async () => {
  const now = new Date();

  git(["checkout", "-b", "feature3"]);
  await writeFile(path.join(repo, "old.ts"), "// old\n");
  git(["add", "."]);
  git(["commit", "-m", "old"]);

  const pr = await createLocalPr(repo, {
    title: "Old PR",
    body: "Old",
    base: "main",
    head: "feature3",
  });

  await addLocalPrComment(repo, pr.id, "Old comment from yesterday", {
    role: "reviewer",
    author: "reviewer",
  });

  const fullSummary = await generateLearningDigest(repo);
  const oldCommentCount = fullSummary.totalComments;

  const recentSummary = await generateLearningDigest(repo, {
    since: now.toISOString(),
  });

  assert.ok(
    recentSummary.totalComments < oldCommentCount,
    "Should filter out old comments with since parameter",
  );
});

test("formatLearningDigest produces readable output", async () => {
  git(["checkout", "-b", "feature4"]);
  await writeFile(path.join(repo, "format.ts"), "// format\n");
  git(["add", "."]);
  git(["commit", "-m", "format"]);

  const pr = await createLocalPr(repo, {
    title: "Format PR",
    body: "Format",
    base: "main",
    head: "feature4",
  });

  await addLocalPrComment(repo, pr.id, "Missing tests here", {
    role: "reviewer",
    path: "format.ts",
  });

  const summary = await generateLearningDigest(repo);
  const formatted = formatLearningDigest(summary);

  assert.ok(formatted.includes("PR Genie Learning Digest"), "Should include title");
  assert.ok(formatted.includes("Analyzed"), "Should include analysis summary");
  assert.match(formatted, /comment\(s\)/i, "Should mention comments");
});

test("generateLearningDigest handles empty sessions file gracefully", async () => {
  const tempRepo = await mkdtemp(path.join(tmpdir(), "prgenie-learning-empty-"));
  try {
    git(["init", "-b", "main"], tempRepo);
    git(["config", "user.email", "test@prgenie.ai"], tempRepo);
    git(["config", "user.name", "Test"], tempRepo);
    await writeFile(path.join(tempRepo, "README.md"), "test\n");
    git(["add", "."], tempRepo);
    git(["commit", "-m", "init"], tempRepo);

    const summary = await generateLearningDigest(tempRepo);
    assert.equal(summary.totalComments, 0);
    assert.equal(summary.totalSessions, 0);
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("generateLearningDigest skips comments with invalid timestamps when filtering by since", async () => {
  git(["checkout", "-b", "feature5"]);
  await writeFile(path.join(repo, "timestamp.ts"), "// timestamp\n");
  git(["add", "."]);
  git(["commit", "-m", "timestamp"]);

  const pr = await createLocalPr(repo, {
    title: "Timestamp PR",
    body: "Timestamp",
    base: "main",
    head: "feature5",
  });

  await addLocalPrComment(repo, pr.id, "Valid comment", {
    role: "reviewer",
    author: "reviewer",
  });

  const prData = await getLocalPr(repo, pr.id);
  const commentId = prData.comments[0].id;

  const dir = path.join(repo, ".git", "agent-console", "prs");
  const prFile = path.join(dir, `${pr.id}.json`);
  const prContent = JSON.parse(await readFile(prFile, "utf8"));
  const comment = prContent.comments.find((c: { id: string }) => c.id === commentId);
  comment.createdAt = "invalid-date";
  await writeFile(prFile, JSON.stringify(prContent, null, 2));

  const now = new Date();
  const summary = await generateLearningDigest(repo, {
    since: now.toISOString(),
  });

  assert.equal(
    summary.totalComments,
    0,
    "Should skip comment with invalid timestamp when filtering by since",
  );
});
