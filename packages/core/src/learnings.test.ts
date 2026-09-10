import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  addLearnings,
  completeLocalPrReview,
  createLocalPr,
  disableLearning,
  enableLearning,
  deleteLearning,
  getLearning,
  listLearnings,
  runPreflight,
  setLocalPrStatus,
  addLocalPrComment,
  addressLocalPrComment,
  type Learning,
} from "./index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prgenie-learnings-test-"));
  execSync("git init", { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync("git commit --allow-empty -m init", { cwd: dir });
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("learning extraction from resolved comments", async () => {
  const repo = setup();
  try {
    const pr = await createLocalPr(repo, {
      title: "Test PR",
      body: "Test body",
    });

    await setLocalPrStatus(repo, pr.id, "ready", { skipPreflight: true });
    const commented = await addLocalPrComment(
      repo,
      pr.id,
      "Pattern: Missing tests\nFix: Add test coverage",
      {
        role: "reviewer",
      },
    );

    const learningsBefore = await listLearnings(repo);
    assert.equal(learningsBefore.length, 0);

    await addressLocalPrComment(repo, pr.id, commented.comments[0].id, "Fixed");
    await completeLocalPrReview(repo, pr.id);

    const learningsAfter = await listLearnings(repo);
    assert.equal(learningsAfter.length, 1);
    assert.ok(learningsAfter[0].pattern.toLowerCase().includes("missing tests"));
  } finally {
    cleanup(repo);
  }
});

test("learning CRUD operations", async () => {
  const repo = setup();
  try {
    const learning: Learning = {
      id: "learn-test123",
      pattern: "test pattern",
      guidance: "test guidance",
      sourceCommentId: "c-123",
      sourcePrId: "lp-456",
      createdAt: new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      disabled: false,
      category: "testing",
    };

    await addLearnings(repo, [learning]);

    const retrieved = await getLearning(repo, "learn-test123");
    assert.ok(retrieved);
    assert.equal(retrieved.pattern, "test pattern");

    const listed = await listLearnings(repo);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "learn-test123");

    const disabled = await disableLearning(repo, "learn-test123");
    assert.equal(disabled.disabled, true);

    const enabledAgain = await enableLearning(repo, "learn-test123");
    assert.equal(enabledAgain.disabled, false);

    const deleted = await deleteLearning(repo, "learn-test123");
    assert.equal(deleted.deleted, true);

    const afterDelete = await listLearnings(repo);
    assert.equal(afterDelete.length, 0);
  } finally {
    cleanup(repo);
  }
});

test("preflight check blocks ready when pattern matches", async () => {
  const repo = setup();
  try {
    const learning: Learning = {
      id: "learn-test789",
      pattern: "forbidden pattern",
      guidance: "Do not use this pattern",
      sourceCommentId: "c-789",
      sourcePrId: "lp-789",
      createdAt: new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      disabled: false,
    };

    await addLearnings(repo, [learning]);

    const pr = await createLocalPr(repo, {
      title: "Test with forbidden pattern",
      body: "This contains the forbidden pattern",
    });

    await assert.rejects(async () => setLocalPrStatus(repo, pr.id, "ready"), /Preflight failed/);

    await setLocalPrStatus(repo, pr.id, "ready", { skipPreflight: true });
    assert.equal(pr.status, "draft");
  } finally {
    cleanup(repo);
  }
});

test("preflight allows ready when no patterns match", async () => {
  const repo = setup();
  try {
    const learning: Learning = {
      id: "learn-test999",
      pattern: "some pattern",
      guidance: "some guidance",
      sourceCommentId: "c-999",
      sourcePrId: "lp-999",
      createdAt: new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      disabled: false,
    };

    await addLearnings(repo, [learning]);

    const pr = await createLocalPr(repo, {
      title: "Clean PR",
      body: "No problematic patterns here",
    });

    const updated = await setLocalPrStatus(repo, pr.id, "ready");
    assert.equal(updated.status, "ready");
  } finally {
    cleanup(repo);
  }
});

test("disabled learnings do not block preflight", async () => {
  const repo = setup();
  try {
    const learning: Learning = {
      id: "learn-disabled",
      pattern: "disabled pattern",
      guidance: "should not block",
      sourceCommentId: "c-dis",
      sourcePrId: "lp-dis",
      createdAt: new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      disabled: true,
    };

    await addLearnings(repo, [learning]);

    const pr = await createLocalPr(repo, {
      title: "PR with disabled pattern",
      body: "Contains disabled pattern",
    });

    const updated = await setLocalPrStatus(repo, pr.id, "ready");
    assert.equal(updated.status, "ready");
  } finally {
    cleanup(repo);
  }
});

test("runPreflight returns issues when patterns match", async () => {
  const repo = setup();
  try {
    const learning: Learning = {
      id: "learn-check",
      pattern: "check pattern",
      guidance: "check guidance",
      sourceCommentId: "c-check",
      sourcePrId: "lp-check",
      createdAt: new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      disabled: false,
    };

    await addLearnings(repo, [learning]);

    const pr = await createLocalPr(repo, {
      title: "PR with check pattern in title",
      body: "Body text",
    });

    const result = await runPreflight(repo, pr);
    assert.equal(result.passed, false);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].pattern, "check pattern");
    assert.equal(result.issues[0].matchedIn, "title");
  } finally {
    cleanup(repo);
  }
});

test("learning extraction handles addressed then resolved flow", async () => {
  const repo = setup();
  try {
    const pr = await createLocalPr(repo, {
      title: "Test addressed flow",
      body: "Test body",
    });

    await setLocalPrStatus(repo, pr.id, "ready");
    const commented = await addLocalPrComment(
      repo,
      pr.id,
      "Issue: Use const instead of let\nSolution: Change to const",
      {
        role: "reviewer",
      },
    );

    await addressLocalPrComment(repo, pr.id, commented.comments[0].id, "Fixed");

    const learningsBefore = await listLearnings(repo);
    assert.equal(learningsBefore.length, 0);

    await completeLocalPrReview(repo, pr.id);

    const learningsAfter = await listLearnings(repo);
    assert.equal(learningsAfter.length, 1);
    assert.ok(learningsAfter[0].pattern.toLowerCase().includes("const"));
  } finally {
    cleanup(repo);
  }
});
