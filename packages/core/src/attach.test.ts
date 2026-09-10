import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  attachLocalPr,
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
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-attach-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);

  // Create a bare repo to act as a remote
  const bare = await mkdtemp(path.join(tmpdir(), "prgenie-bare-"));
  git(["init", "--bare"], bare);
  git(["remote", "add", "origin", bare]);

  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["push", "-u", "origin", "main"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("attachLocalPr creates a lane from branch name", async () => {
  // Create a branch for this test
  git(["checkout", "-b", "feat/test-1"]);
  await writeFile(path.join(repo, "feature.txt"), "attached feature\n");
  git(["add", "."]);
  git(["commit", "-m", "add feature"]);
  git(["push", "-u", "origin", "feat/test-1"]);
  git(["checkout", "main"]);

  const pr = await attachLocalPr(repo, {
    source: "feat/test-1",
    title: "Attached Feature",
    body: "Testing attach",
  });

  assert.equal(pr.headRef, "feat/test-1");
  assert.equal(pr.baseRef, "main");
  assert.equal(pr.title, "Attached Feature");
  assert.equal(pr.body, "Testing attach");
  assert.equal(pr.status, "draft");
  assert.ok(pr.headSha);
  assert.ok(pr.baseSha);
  assert.ok(pr.worktreePath);
});

test("attachLocalPr rejects duplicate attach for same branch", async () => {
  // Create a branch for this test
  git(["checkout", "-b", "feat/test-2"]);
  await writeFile(path.join(repo, "dup.txt"), "test\n");
  git(["add", "."]);
  git(["commit", "-m", "test"]);
  git(["push", "-u", "origin", "feat/test-2"]);
  git(["checkout", "main"]);

  await attachLocalPr(repo, {
    source: "feat/test-2",
    title: "First attach",
  });

  await assert.rejects(
    async () =>
      attachLocalPr(repo, {
        source: "feat/test-2",
        title: "Second attach",
      }),
    /already exists/,
  );
});

test("attached PR goes through full export validation workflow", async () => {
  // Create remote branch
  git(["checkout", "-b", "feat/validation-test"]);
  await writeFile(path.join(repo, "validated.txt"), "validated content\n");
  git(["add", "."]);
  git(["commit", "-m", "validation test"]);
  git(["push", "-u", "origin", "feat/validation-test"]);
  git(["checkout", "main"]);

  // Attach the branch
  const pr = await attachLocalPr(repo, {
    source: "feat/validation-test",
    title: "Validation Test PR",
  });

  // Should block export while draft
  let result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /Review incomplete.*status is draft/);

  // Move to ready
  await setLocalPrStatus(repo, pr.id, "ready");

  // Should still block without complete review
  result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /Review incomplete.*status is ready/);

  // Complete review
  await completeLocalPrReview(repo, pr.id, {
    body: "Looks good",
  });

  // Should now pass validation
  result = await validateExport(repo, pr.id);
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test("attached PR is blocked by Learn #18 preflight patterns", async () => {
  // Create a learning pattern
  const learning: Learning = {
    id: "learn-attach",
    pattern: "TODO:",
    guidance: "Remove TODO comments before export",
    sourceCommentId: "test-comment",
    sourcePrId: "test-pr",
    createdAt: new Date().toISOString(),
    learnedAt: new Date().toISOString(),
    disabled: false,
  };
  await addLearnings(repo, [learning]);

  // Create branch with pattern
  git(["checkout", "-b", "feat/with-todo"]);
  await writeFile(path.join(repo, "work.js"), "// TODO: finish this\n");
  git(["add", "."]);
  git(["commit", "-m", "work in progress"]);
  git(["push", "-u", "origin", "feat/with-todo"]);
  git(["checkout", "main"]);

  // Attach and review (skip preflight on ready to test export validation)
  const pr = await attachLocalPr(repo, {
    source: "feat/with-todo",
    title: "Work in progress",
  });
  await setLocalPrStatus(repo, pr.id, "ready", { skipPreflight: true });
  await completeLocalPrReview(repo, pr.id);

  // Export validation should catch the pattern
  const result = await validateExport(repo, pr.id);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("TODO:")));
  assert.ok(result.issues.some((issue) => issue.includes("Remove TODO comments")));
});

test("attached PR records correct SHAs for export", async () => {
  // Create branch
  git(["checkout", "-b", "feat/sha-test"]);
  await writeFile(path.join(repo, "sha.txt"), "sha test\n");
  git(["add", "."]);
  git(["commit", "-m", "sha commit"]);
  const commitSha = git(["rev-parse", "HEAD"]);
  git(["push", "-u", "origin", "feat/sha-test"]);
  git(["checkout", "main"]);

  // Attach
  const pr = await attachLocalPr(repo, {
    source: "feat/sha-test",
    title: "SHA Test",
  });

  // Should record the branch HEAD SHA
  assert.equal(pr.headSha, commitSha);
  assert.equal(pr.headRef, "feat/sha-test");
});

test("attached PR respects base override", async () => {
  // Create a different base branch
  git(["checkout", "-b", "develop"]);
  await writeFile(path.join(repo, "develop.txt"), "develop branch\n");
  git(["add", "."]);
  git(["commit", "-m", "develop"]);
  git(["push", "-u", "origin", "develop"]);

  // Create feature from develop
  git(["checkout", "-b", "feat/from-develop"]);
  await writeFile(path.join(repo, "feature-dev.txt"), "from develop\n");
  git(["add", "."]);
  git(["commit", "-m", "feature from develop"]);
  git(["push", "-u", "origin", "feat/from-develop"]);
  git(["checkout", "main"]);

  // Attach with base override
  const pr = await attachLocalPr(repo, {
    source: "feat/from-develop",
    base: "develop",
    title: "Feature from develop",
  });

  assert.equal(pr.baseRef, "develop");
  assert.equal(pr.headRef, "feat/from-develop");
});
