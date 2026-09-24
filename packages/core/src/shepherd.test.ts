import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shepherdStatus } from "./shepherd.js";
import type { ProgressEvent } from "./progress.js";
import { git } from "./git.js";
import { createLocalPr, setLocalPrStatus, addLocalPrComment } from "./prs.js";
import { addLearnings } from "./learnings.js";
import type { Learning } from "./types.js";
import type { CiCheckSelection } from "./ci-select.js";

/** Test-only: force root check names so fixtures that stub package.json scripts still exercise the runner. */
function fixtureRootSelection(checks: string[], paths: string[] = ["test.txt"]): CiCheckSelection {
  return {
    checks,
    reason: ["test fixture: caller-forced root checks (not selectCiChecks)"],
    mapping: checks.map((check) => ({ check, reason: "fixture" })),
    uncertain: false,
    changedPaths: paths,
    packageScoped: false,
    skipped: false,
  };
}

/**
 * Create a cross-platform symlink to node_modules.
 * On Windows, uses junction which doesn't require admin privileges.
 * On Unix, uses a standard symlink.
 */
async function linkNodeModules(targetDir: string, sourceModulesPath: string): Promise<void> {
  const linkPath = join(targetDir, "node_modules");
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(sourceModulesPath, linkPath, type);
}

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

      const pr = await createLocalPr(repo, {
        title: "PR with CI failure",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);

      // Create a package.json with a failing lint check in the exclusive worktree
      await writeFile(
        join(pr.worktreePath, "package.json"),
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

      await setLocalPrStatus(repo, pr.id, "reviewed");

      // Skip github check but allow CI check to run (exit-script fixture — no real bins).
      // Force the root plan: selectCiChecks would skip this fixture diff (RAD-119).
      const result = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        selection: fixtureRootSelection(["format:check", "lint", "typecheck", "test", "build"]),
      });

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

      // Create .gitignore before linking node_modules to prevent git from indexing through junction on Windows
      await writeFile(join(repo, ".gitignore"), "node_modules\n");

      // Create a badly formatted JS file that will fail format:check
      await writeFile(join(repo, "bad.js"), 'const x = "bad"\n');
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "PR with multiple CI failures",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);
      await linkNodeModules(pr.worktreePath, join(process.cwd(), "node_modules"));

      // Create a package.json with multiple failing checks
      await writeFile(
        join(pr.worktreePath, "package.json"),
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

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const result = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        failFast: false,
        parallel: false,
        selection: fixtureRootSelection(["format:check", "lint", "typecheck", "test", "build"]),
      });

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

      const pr = await createLocalPr(repo, {
        title: "PR with passing CI",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);

      // Create a package.json with all passing checks
      await writeFile(
        join(pr.worktreePath, "package.json"),
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

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const result = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
      });

      assert.equal(result.status, "ready");
      const ciReasons = result.reasons.filter((r) => r.check === "ci");
      assert.equal(ciReasons.length, 0, "Should have no CI blocking reasons");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("skipCiCheck does not run failing CI scripts (sidebar cheap path)", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "PR with CI failure",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);

      await writeFile(
        join(pr.worktreePath, "package.json"),
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

      await setLocalPrStatus(repo, pr.id, "reviewed");

      const cheap = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipCiCheck: true,
      });
      assert.equal(cheap.status, "ready", "sidebar cheap path must not wait on CI");
      assert.equal(
        cheap.reasons.filter((r) => r.check === "ci").length,
        0,
        "skipCiCheck must not report CI failures",
      );

      const full = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        selection: fixtureRootSelection(["format:check", "lint", "typecheck", "test", "build"]),
      });
      assert.equal(full.status, "blocked", "CLI/default path still runs CI when plan is forced");
      assert.ok(full.reasons.some((r) => r.check === "ci"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("CI env unhealthy does not hard-block export by default (RAD-92)", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);

      const pr = await createLocalPr(repo, {
        title: "PR missing toolchain",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);
      // No node_modules on primary or worktree — ensure reports env unhealthy.
      await setLocalPrStatus(repo, pr.id, "reviewed");

      const soft = await shepherdStatus(repo, pr.id, { skipGithubCheck: true });
      assert.equal(soft.status, "ready", "env unhealthy alone must not hard-block");
      assert.equal(soft.reasons.filter((r) => r.check === "ci").length, 0);
      assert.ok(soft.ciEnvUnhealthy);
      assert.match(soft.ciEnvUnhealthy.message, /Missing toolchain|unhealthy/i);
      assert.ok(soft.ciEnvUnhealthy.fixSteps.length > 0);

      const hard = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        hardBlockCiEnv: true,
      });
      assert.equal(hard.status, "blocked");
      assert.ok(hard.reasons.some((r) => r.check === "ci" && /unhealthy/i.test(r.message)));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("streams gate progress including the failing CI command", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test content\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add test"]);
      const pr = await createLocalPr(repo, {
        title: "Progress PR",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);
      await writeFile(
        join(pr.worktreePath, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            test: "exit 1",
            build: "exit 0",
          },
        }),
      );
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const events: ProgressEvent[] = [];
      const result = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        selection: fixtureRootSelection(["format:check", "lint", "typecheck", "test", "build"]),
        onProgress: (event) => events.push(event),
      });
      assert.equal(result.status, "blocked");
      assert.ok(events.some((e) => e.phase === "review" && e.state === "start"));
      assert.ok(events.some((e) => e.phase === "review" && e.state === "pass"));
      assert.ok(events.some((e) => e.phase === "ci" && e.check === "test" && e.state === "fail"));
      assert.ok(
        events.some((e) => e.phase === "ci" && e.check === "test" && e.command === "pnpm test"),
      );
      assert.ok(
        result.reasons.some((r) => r.message.includes("test") && r.message.includes("pnpm test")),
      );
      assert.ok(
        result.reasons.some((r) => r.message.includes("CI check failed: test")),
        "blocked reason must name the failing check",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-74: CI block names the check and includes a test excerpt + log path", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(join(repo, "test.txt"), "test content\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Add failing test"]);
      const pr = await createLocalPr(repo, {
        title: "Excerpt PR",
        body: "Body",
        base: "main",
        head: "feature",
      });
      assert.ok(pr.worktreePath);
      // Untracked helpers in the exclusive worktree: format:check ignores them.
      await writeFile(
        join(pr.worktreePath, "fail-test.mjs"),
        "process.stderr.write('not ok 1 - widget renders\\n'); process.exit(1);\n",
      );
      await writeFile(
        join(pr.worktreePath, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            test: "node fail-test.mjs",
            build: "exit 0",
          },
        }),
      );
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const events: ProgressEvent[] = [];
      const result = await shepherdStatus(repo, pr.id, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        selection: fixtureRootSelection(["format:check", "lint", "typecheck", "test", "build"]),
        onProgress: (event) => events.push(event),
      });
      assert.equal(result.status, "blocked");
      const ci = result.reasons.find((r) => r.check === "ci");
      assert.ok(ci);
      assert.match(ci.message, /CI check failed: test/);
      assert.match(ci.message, /widget renders/);
      assert.match(ci.message, /full log:/);
      assert.ok(
        events.some(
          (e) =>
            e.phase === "ci" &&
            e.check === "test" &&
            e.state === "fail" &&
            /widget renders/.test(e.message ?? ""),
        ),
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
