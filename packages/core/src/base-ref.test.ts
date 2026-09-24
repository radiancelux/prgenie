import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  assertDeclaredBaseAligned,
  checkDeclaredBaseAlignment,
  exportPushArgs,
  exportUpstreamRef,
  type DeclaredBasePr,
} from "./base-ref.js";
import { createLocalPr, pruneLoopWorktrees, setLocalPrStatus } from "./index.js";
import { prFile, prsDir, writeJsonFile } from "./store.js";
import type { LocalPr } from "./types.js";

/** Sequential: tests mutate a shared `repo` path via beforeEach-style helpers. */
describe("RAD-94 declared baseRef", { concurrency: false }, () => {
  let repo = "";

  function git(args: string[], cwd = repo): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  async function freshRepo(): Promise<void> {
    if (repo) {
      await pruneLoopWorktrees(repo).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
    repo = await mkdtemp(path.join(tmpdir(), "prgenie-base-ref-"));
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@prgenie.ai"]);
    git(["config", "user.name", "PR Genie Test"]);
    await writeFile(path.join(repo, "README.md"), "hello\n");
    git(["add", "."]);
    git(["commit", "-m", "initial"]);
  }

  async function stubLivePr(
    patch: Pick<LocalPr, "id" | "headRef" | "headSha" | "baseRef" | "baseSha"> & {
      title?: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const pr: LocalPr = {
      id: patch.id,
      title: patch.title ?? patch.id,
      body: "",
      status: "draft",
      headRef: patch.headRef,
      baseRef: patch.baseRef,
      headSha: patch.headSha,
      baseSha: patch.baseSha,
      worktreePath: null,
      comments: [],
      source: { kind: "cli" },
      createdAt: now,
      updatedAt: now,
      reviewRequestedSha: null,
      reviewerNotifiedSha: null,
    };
    const dir = await prsDir(repo);
    await writeJsonFile(prFile(dir, pr.id), pr);
  }

  after(async () => {
    if (repo) {
      await pruneLoopWorktrees(repo).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("exportUpstreamRef is origin/<headRef>, never the base", () => {
    assert.equal(exportUpstreamRef("lp-deadbeef"), "origin/lp-deadbeef");
    assert.equal(exportUpstreamRef("refs/heads/feat/x"), "origin/feat/x");
    assert.notEqual(exportUpstreamRef("feat/x"), "origin/main");
  });

  test("exportPushArgs pushes recorded SHA without -u", () => {
    assert.deepEqual(exportPushArgs({ headSha: "abc123", headRef: "lp-aabbccdd" }), [
      "push",
      "origin",
      "abc123:refs/heads/lp-aabbccdd",
    ]);
  });

  test("createLocalPr persists baseRef and aligned head reaches ready", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/aligned"]);
    await writeFile(path.join(repo, "aligned.txt"), "ok\n");
    git(["add", "."]);
    git(["commit", "-m", "aligned work"]);
    const pr = await createLocalPr(repo, { title: "Aligned", base: "main" });
    assert.equal(pr.baseRef, "main");
    assert.ok(pr.baseSha);
    const check = await checkDeclaredBaseAlignment(repo, pr);
    assert.equal(check.ok, true);
    await setLocalPrStatus(repo, pr.id, "ready", { skipPreflight: true });
  });

  test("RAD-94: merge-base ≠ declared base tip fails alignment", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/stale"]);
    await writeFile(path.join(repo, "stale.txt"), "a\n");
    git(["add", "."]);
    git(["commit", "-m", "stale feature"]);
    const headSha = git(["rev-parse", "HEAD"]);
    const oldMain = git(["rev-parse", "main"]);
    git(["checkout", "main"]);
    await writeFile(path.join(repo, "main-moved.txt"), "moved\n");
    git(["add", "."]);
    git(["commit", "-m", "main moved"]);
    const pr: DeclaredBasePr = {
      id: "lp-stale001",
      headRef: "feat/stale",
      headSha,
      baseRef: "main",
      baseSha: oldMain,
    };
    const check = await checkDeclaredBaseAlignment(repo, pr);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.match(check.message, /merge-base/);
      assert.equal(check.stackedOn, null);
    }
    await assert.rejects(() => assertDeclaredBaseAligned(repo, pr), /merge-base/);
  });

  test("RAD-94: intermediate WIP bookmark must not fail alignment", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/bookmarked"]);
    await writeFile(path.join(repo, "one.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-m", "first"]);
    await writeFile(path.join(repo, "two.txt"), "2\n");
    git(["add", "."]);
    git(["commit", "-m", "second"]);
    // Same first-parent topology as a linear stack, but not a live loop / lp-* tip.
    git(["branch", "wip-bookmark", "HEAD~1"]);
    const pr: DeclaredBasePr = {
      id: "lp-book0001",
      headRef: "feat/bookmarked",
      headSha: git(["rev-parse", "HEAD"]),
      baseRef: "main",
      baseSha: git(["rev-parse", "main"]),
    };
    const check = await checkDeclaredBaseAlignment(repo, pr);
    assert.equal(check.ok, true, "WIP bookmark on first-parent walk must not look stacked");
    if (check.ok === false) assert.equal(check.stackedOn, null);
  });

  test("RAD-94: bare named parent without a live local PR is not stacked", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/parent"]);
    await writeFile(path.join(repo, "parent.txt"), "parent\n");
    git(["add", "."]);
    git(["commit", "-m", "parent feature"]);
    git(["checkout", "-b", "feat/child"]);
    await writeFile(path.join(repo, "child.txt"), "child\n");
    git(["add", "."]);
    git(["commit", "-m", "child feature"]);
    const pr: DeclaredBasePr = {
      id: "lp-bare0001",
      headRef: "feat/child",
      headSha: git(["rev-parse", "HEAD"]),
      baseRef: "main",
      baseSha: git(["rev-parse", "main"]),
    };
    const check = await checkDeclaredBaseAlignment(repo, pr);
    assert.equal(
      check.ok,
      true,
      "named feature parent without a live local PR is not auto-detected (RAD-87)",
    );
  });

  test("RAD-94: stacked on a live local PR parent fails", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/parent"]);
    await writeFile(path.join(repo, "parent.txt"), "parent\n");
    git(["add", "."]);
    git(["commit", "-m", "parent feature"]);
    const parentSha = git(["rev-parse", "HEAD"]);
    const mainSha = git(["rev-parse", "main"]);
    await stubLivePr({
      id: "lp-parent1",
      headRef: "feat/parent",
      headSha: parentSha,
      baseRef: "main",
      baseSha: mainSha,
      title: "Parent loop",
    });
    git(["checkout", "-b", "feat/child"]);
    await writeFile(path.join(repo, "child.txt"), "child\n");
    git(["add", "."]);
    git(["commit", "-m", "child feature"]);
    const pr: DeclaredBasePr = {
      id: "lp-stack001",
      headRef: "feat/child",
      headSha: git(["rev-parse", "HEAD"]),
      baseRef: "main",
      baseSha: mainSha,
    };
    const check = await checkDeclaredBaseAlignment(repo, pr);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.equal(check.stackedOn, "feat/parent");
      assert.match(check.message, /stacked on feat\/parent/);
      assert.match(check.message, /RAD-87/);
    }
    await assert.rejects(() => assertDeclaredBaseAligned(repo, pr), /stacked on feat\/parent/);
  });

  test("RAD-94: stacked on another lp-* head mentions dependsOn", async () => {
    await freshRepo();
    git(["checkout", "-b", "lp-aaaaaaaa"]);
    await writeFile(path.join(repo, "loop-parent.txt"), "p\n");
    git(["add", "."]);
    git(["commit", "-m", "other loop"]);
    git(["checkout", "-b", "feat/on-loop"]);
    await writeFile(path.join(repo, "loop-child.txt"), "c\n");
    git(["add", "."]);
    git(["commit", "-m", "stacked on loop"]);
    const pr: DeclaredBasePr = {
      id: "lp-deps0001",
      headRef: "feat/on-loop",
      headSha: git(["rev-parse", "HEAD"]),
      baseRef: "main",
      baseSha: git(["rev-parse", "main"]),
    };
    const check = await checkDeclaredBaseAlignment(repo, pr);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.equal(check.stackedOn, "lp-aaaaaaaa");
      assert.match(check.message, /dependsOn/);
    }
  });
});
