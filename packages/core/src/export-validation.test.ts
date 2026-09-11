import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  addLocalPrComment,
  createLocalPr,
  setLocalPrStatus,
  validateExport,
  completeLocalPrReview,
  addLearnings,
  type Learning,
} from "./index.js";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-export-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feat/widget"]);
  await writeFile(path.join(repo, "widget.txt"), "n=1\n");
  git(["add", "."]);
  git(["commit", "-m", "add widget"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("export validation blocks draft status", async () => {
  const pr = await createLocalPr(repo, {
    title: "Draft PR",
    body: "Not ready yet",
    base: "main",
  });

  const result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  // Should have review block (draft) plus likely GitHub/CI blocks
  const reviewIssue = result.issues.find((i) => i.includes("Review"));
  assert.ok(reviewIssue);
  assert.match(reviewIssue, /draft/);
});

test("export validation blocks ready status with no review", async () => {
  const pr = await createLocalPr(repo, {
    title: "Ready PR",
    body: "Waiting for review",
    base: "main",
  });
  await setLocalPrStatus(repo, pr.id, "ready");

  const result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  const reviewIssue = result.issues.find((i) => i.includes("Review"));
  assert.ok(reviewIssue);
  assert.match(reviewIssue, /ready/);
});

test("export validation blocks changes_requested with pending comments", async () => {
  const pr = await createLocalPr(repo, {
    title: "PR with findings",
    body: "Has open comments",
    base: "main",
  });
  await setLocalPrStatus(repo, pr.id, "ready");
  await addLocalPrComment(repo, pr.id, "Please fix this bug", {
    role: "reviewer",
  });

  const result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  const reviewIssue = result.issues.find((i) => i.includes("Review"));
  assert.ok(reviewIssue);
  assert.match(reviewIssue, /1 open finding/);
});

test("export validation allows reviewed status", async () => {
  const pr = await createLocalPr(repo, {
    title: "Reviewed PR",
    body: "All good",
    base: "main",
  });
  await setLocalPrStatus(repo, pr.id, "ready");
  await completeLocalPrReview(repo, pr.id, {
    body: "Looks good",
  });

  const result = await validateExport(repo, pr.id);
  // Will be blocked by GitHub/CI checks in test env, but review should pass
  const reviewIssue = result.issues.find((i) => i.includes("Review"));
  assert.equal(reviewIssue, undefined, "Review should not be blocking");
});

test("export validation allows approved status", async () => {
  const pr = await createLocalPr(repo, {
    title: "Approved PR",
    body: "Already approved",
    base: "main",
  });
  await setLocalPrStatus(repo, pr.id, "approved");

  const result = await validateExport(repo, pr.id);
  // Will be blocked by GitHub/CI checks in test env, but review should pass
  const reviewIssue = result.issues.find((i) => i.includes("Review"));
  assert.equal(reviewIssue, undefined, "Review should not be blocking");
});

test("export validation can be skipped with skipValidation flag", async () => {
  const pr = await createLocalPr(repo, {
    title: "Draft PR",
    body: "Emergency export",
    base: "main",
  });

  const result = await validateExport(repo, pr.id, {
    skipValidation: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test("export validation blocks when Learn #18 preflight pattern matches", async () => {
  // Create a learning pattern that will match
  const learning: Learning = {
    id: "learn-test",
    pattern: "console.log",
    guidance: "Remove debug console statements before export",
    sourceCommentId: "test-comment",
    sourcePrId: "test-pr",
    createdAt: new Date().toISOString(),
    learnedAt: new Date().toISOString(),
    disabled: false,
  };
  await addLearnings(repo, [learning]);

  const pr = await createLocalPr(repo, {
    title: "PR with console.log",
    body: "Has debug statements",
    base: "main",
  });
  await setLocalPrStatus(repo, pr.id, "reviewed");

  // Add a file with console.log
  git(["checkout", pr.headRef]);
  await writeFile(path.join(repo, "debug.js"), "console.log('debug');\n");
  git(["add", "."]);
  git(["commit", "-m", "add debug"]);

  const result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  const preflightIssue = result.issues.find((i) => i.includes("Preflight"));
  assert.ok(preflightIssue);
  assert.match(preflightIssue, /console\.log/);
});
