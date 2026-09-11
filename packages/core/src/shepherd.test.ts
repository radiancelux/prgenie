import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { shepherdStatus } from "./shepherd.js";
import { git } from "./git.js";
import { createLocalPr, setLocalPrStatus, addLocalPrComment } from "./prs.js";
import { addLearnings } from "./learnings.js";
import type { Learning } from "./types.js";

const execAsync = promisify(exec);

async function initRepo(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "prgenie-shepherd-test-"));
  await git(tmp, ["init", "-b", "main"]);
  await git(tmp, ["config", "user.email", "test@example.com"]);
  await git(tmp, ["config", "user.name", "Test User"]);
  await writeFile(join(tmp, "README.md"), "# Test\n");
  await git(tmp, ["add", "."]);
  await git(tmp, ["commit", "-m", "Initial commit"]);
  return tmp;
}

describe("shepherdStatus", () => {
  it("returns ready when all checks pass", async () => {
    const repo = await initRepo();
    try {
      // Create PR and approve it
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test content\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "Test PR",
        body: "Test body",
        base: "main",
        head: "feature",
      });

      // Mark as reviewed (simulating complete review)
      await setLocalPrStatus(repo, pr.id, "reviewed");

      // Skip GitHub check and CI check for testing (no gh CLI / CI env in test)
      const result = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipCiCheck: true,
      });

      // Assert proper ready path
      assert.equal(result.status, "ready");
      assert.equal(result.reasons.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked when status is draft", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "Draft PR",
        body: "Draft body",
        base: "main",
        head: "feature",
      });

      // PR starts as draft
      const result = await shepherdStatus(repo, pr.id);

      assert.equal(result.status, "blocked");
      const reviewReasons = result.reasons.filter((r) => r.check === "review");
      assert.ok(reviewReasons.length > 0);
      assert.ok(
        reviewReasons.some((r) => r.message.includes("draft")),
        "Should mention draft status",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked when review has pending findings", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "PR with findings",
        body: "Body",
        base: "main",
        head: "feature",
      });

      // Add an open finding
      await addLocalPrComment(repo, pr.id, "Fix this issue", {
        role: "reviewer",
        path: "test.txt",
        line: 1,
      });

      await setLocalPrStatus(repo, pr.id, "changes_requested");

      const result = await shepherdStatus(repo, pr.id);

      assert.equal(result.status, "blocked");
      const reviewReasons = result.reasons.filter((r) => r.check === "review");
      assert.ok(reviewReasons.length > 0);
      assert.ok(
        reviewReasons.some((r) => r.message.includes("open finding")),
        "Should mention open findings",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked when preflight fails", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      // Add a learning that will match
      const learning: Learning = {
        id: "learn-test",
        pattern: "test content",
        guidance: "Don't use test content",
        sourceCommentId: "comment-1",
        sourcePrId: "pr-1",
        createdAt: new Date().toISOString(),
        learnedAt: new Date().toISOString(),
        disabled: false,
      };
      await addLearnings(repo, [learning]);

      const pr = await createLocalPr(repo, {
        title: "PR with test content",
        body: "This has test content in it",
        base: "main",
        head: "feature",
      });

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const result = await shepherdStatus(repo, pr.id);

      assert.equal(result.status, "blocked");
      const preflightReasons = result.reasons.filter((r) => r.check === "preflight");
      assert.ok(preflightReasons.length > 0);
      assert.ok(
        preflightReasons.some((r) => r.message.includes("test content")),
        "Should mention the pattern that failed",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked when github is not bound", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "Unbound PR",
        body: "Body",
        base: "main",
        head: "feature",
      });

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const result = await shepherdStatus(repo, pr.id);

      assert.equal(result.status, "blocked");
      const githubReasons = result.reasons.filter((r) => r.check === "github");
      assert.ok(githubReasons.length > 0);
      assert.ok(
        githubReasons.some((r) => r.message.includes("GitHub") || r.message.includes("bound")),
        "Should mention GitHub binding issue",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked with multiple reasons when multiple checks fail", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      // Add a learning that will match
      const learning: Learning = {
        id: "learn-multi",
        pattern: "bad pattern",
        guidance: "Don't use this",
        sourceCommentId: "comment-1",
        sourcePrId: "pr-1",
        createdAt: new Date().toISOString(),
        learnedAt: new Date().toISOString(),
        disabled: false,
      };
      await addLearnings(repo, [learning]);

      const pr = await createLocalPr(repo, {
        title: "Multi-fail PR with bad pattern",
        body: "Body",
        base: "main",
        head: "feature",
      });

      // Leave as draft (review will fail)
      // Title contains "bad pattern" (preflight will fail)
      // No gh bind (github will fail)

      const result = await shepherdStatus(repo, pr.id);

      assert.equal(result.status, "blocked");
      assert.ok(result.reasons.length >= 2, "Should have multiple blocking reasons");

      // Should have at least review and preflight failures
      const checks = new Set(result.reasons.map((r) => r.check));
      assert.ok(checks.has("review"));
      assert.ok(checks.has("preflight"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked when CI checks fail", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      // Create a package.json with a failing lint check
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 1",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      const pr = await createLocalPr(repo, {
        title: "PR with CI failure",
        body: "Body",
        base: "main",
        head: "feature",
      });

      await setLocalPrStatus(repo, pr.id, "reviewed");

      // Skip github check but allow CI check to run
      const result = await shepherdStatus(repo, pr.id, { skipGithubCheck: true });

      assert.equal(result.status, "blocked");
      const ciReasons = result.reasons.filter((r) => r.check === "ci");
      assert.ok(ciReasons.length > 0, "Should have CI blocking reason");
      assert.ok(
        ciReasons.some((r) => r.message.includes("lint")),
        "Should mention lint check failure",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns blocked with multiple CI failures", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);

      // Link node_modules for prettier access
      await execAsync(`ln -s ${join(process.cwd(), "node_modules")} ${join(repo, "node_modules")}`);

      // Create a badly formatted JS file that will fail format:check
      await writeFile(join(repo, "bad.js"), 'const x = "bad"\n');
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      // Create a package.json with multiple failing checks
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            lint: "exit 1",
            typecheck: "exit 0",
            test: "exit 1",
            build: "exit 0",
          },
        }),
      );

      const pr = await createLocalPr(repo, {
        title: "PR with multiple CI failures",
        body: "Body",
        base: "main",
        head: "feature",
      });

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const result = await shepherdStatus(repo, pr.id, { skipGithubCheck: true });

      assert.equal(result.status, "blocked");
      const ciReasons = result.reasons.filter((r) => r.check === "ci");
      assert.equal(ciReasons.length, 3, "Should have 3 CI blocking reasons");

      const ciMessages = ciReasons.map((r) => r.message).join(" ");
      assert.ok(ciMessages.includes("format:check"), "Should mention format:check failure");
      assert.ok(ciMessages.includes("lint"), "Should mention lint failure");
      assert.ok(ciMessages.includes("test"), "Should mention test failure");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns ready when CI checks pass", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      // Create a package.json with all passing checks
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            test: "exit 0",
            build: "exit 0",
          },
        }),
      );

      const pr = await createLocalPr(repo, {
        title: "PR with passing CI",
        body: "Body",
        base: "main",
        head: "feature",
      });

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const result = await shepherdStatus(repo, pr.id, { skipGithubCheck: true });

      assert.equal(result.status, "ready");
      const ciReasons = result.reasons.filter((r) => r.check === "ci");
      assert.equal(ciReasons.length, 0, "Should have no CI blocking reasons");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
