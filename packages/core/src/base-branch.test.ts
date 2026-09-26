import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  assertBaseRefIsBranch,
  assertStoredBaseRefIsBranch,
  classifyBaseRefAsBranch,
  normalizeStoredBaseRef,
  suggestBranchForSha,
} from "./base-ref.js";
import {
  archiveLocalPr,
  createLocalPr,
  getLocalPr,
  pruneLoopWorktrees,
  setLocalPrStatus,
  validateExport,
} from "./index.js";
import { prFile, prsDir, writeJsonFile } from "./store.js";
import type { LocalPr } from "./types.js";

/** Sequential: tests mutate a shared `repo` path. */
describe("RAD-145 / RAD-149 branch-only base and duplicate head", { concurrency: false }, () => {
  let repo = "";

  function git(args: string[], cwd = repo): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  async function freshRepo(): Promise<void> {
    if (repo) {
      await pruneLoopWorktrees(repo).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
    repo = await mkdtemp(path.join(tmpdir(), "prgenie-base-branch-"));
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@prgenie.ai"]);
    git(["config", "user.name", "PR Genie Test"]);
    await writeFile(path.join(repo, "README.md"), "hello\n");
    git(["add", "."]);
    git(["commit", "-m", "initial"]);
  }

  after(async () => {
    if (repo) {
      await pruneLoopWorktrees(repo).catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("normalizeStoredBaseRef collapses main, origin/main, refs/heads/main", () => {
    assert.equal(normalizeStoredBaseRef("main"), "main");
    assert.equal(normalizeStoredBaseRef("origin/main"), "main");
    assert.equal(normalizeStoredBaseRef("refs/heads/main"), "main");
  });

  test("classifyBaseRefAsBranch accepts branch forms and rejects SHAs", async () => {
    await freshRepo();
    assert.equal(await classifyBaseRefAsBranch(repo, "main"), "local");
    assert.equal(await classifyBaseRefAsBranch(repo, "refs/heads/main"), "local");
    const mainSha = git(["rev-parse", "main"]);
    assert.equal(await classifyBaseRefAsBranch(repo, mainSha), null);
  });

  test("createLocalPr refuses a commit SHA baseRef", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/sha-base"]);
    await writeFile(path.join(repo, "work.txt"), "x\n");
    git(["add", "."]);
    git(["commit", "-m", "work"]);
    const sha = git(["rev-parse", "main"]);
    await assert.rejects(
      () => createLocalPr(repo, { title: "Bad base", base: sha }),
      /is a commit.*branch name/,
    );
  });

  test("createLocalPr accepts branch baseRef and normalizes origin/main", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/good"]);
    await writeFile(path.join(repo, "good.txt"), "ok\n");
    git(["add", "."]);
    git(["commit", "-m", "good"]);
    const pr = await createLocalPr(repo, { title: "Good base", base: "origin/main" });
    assert.equal(pr.baseRef, "main");
  });

  test("createLocalPr resolves baseSha from origin/main when local main differs", async () => {
    await freshRepo();
    const originTip = git(["rev-parse", "main"]);
    const bare = await mkdtemp(path.join(tmpdir(), "prgenie-base-remote-"));
    git(["init", "--bare", "-b", "main"], bare);
    git(["remote", "add", "origin", bare]);
    git(["push", "-u", "origin", "main"]);
    await writeFile(path.join(repo, "local-ahead.txt"), "ahead\n");
    git(["add", "."]);
    git(["commit", "-m", "local main ahead"]);
    assert.notEqual(git(["rev-parse", "main"]), originTip);
    git(["checkout", "-b", "feat/remote-base"]);
    await writeFile(path.join(repo, "feat.txt"), "f\n");
    git(["add", "."]);
    git(["commit", "-m", "feat"]);
    const pr = await createLocalPr(repo, { title: "Remote base", base: "origin/main" });
    assert.equal(pr.baseRef, "main");
    assert.equal(pr.baseSha, originTip);
  });

  test("createLocalPr resolves origin/main when local main is missing", async () => {
    await freshRepo();
    const originTip = git(["rev-parse", "main"]);
    const bare = await mkdtemp(path.join(tmpdir(), "prgenie-base-remote-"));
    git(["init", "--bare", "-b", "main"], bare);
    git(["remote", "add", "origin", bare]);
    git(["push", "-u", "origin", "main"]);
    git(["checkout", "-b", "feat/no-local-main"]);
    await writeFile(path.join(repo, "solo.txt"), "solo\n");
    git(["add", "."]);
    git(["commit", "-m", "solo"]);
    git(["branch", "-D", "main"]);
    const pr = await createLocalPr(repo, { title: "No local main", base: "origin/main" });
    assert.equal(pr.baseRef, "main");
    assert.equal(pr.baseSha, originTip);
  });

  test("legacy SHA baseRef packet fails validateExport before gh", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/export-sha"]);
    await writeFile(path.join(repo, "export.txt"), "e\n");
    git(["add", "."]);
    git(["commit", "-m", "export work"]);
    const pr = await createLocalPr(repo, { title: "Export SHA", base: "main" });
    const mainSha = git(["rev-parse", "main"]);
    const dir = await prsDir(repo);
    const stored = JSON.parse(await readFile(prFile(dir, pr.id), "utf8")) as LocalPr;
    stored.baseRef = mainSha;
    await writeJsonFile(prFile(dir, pr.id), stored);
    const result = await validateExport(repo, pr.id);
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /is a commit/);
  });

  test("second create on the same head is refused", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/dup"]);
    await writeFile(path.join(repo, "dup.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-m", "dup"]);
    const first = await createLocalPr(repo, { title: "First", base: "main", head: "feat/dup" });
    await assert.rejects(
      () => createLocalPr(repo, { title: "Second", base: "main", head: "feat/dup" }),
      new RegExp(`live loop ${first.id}.*update_local_pr`),
    );
  });

  test("second create refused when bases differ only by origin/ prefix", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/prefix"]);
    await writeFile(path.join(repo, "prefix.txt"), "p\n");
    git(["add", "."]);
    git(["commit", "-m", "prefix"]);
    const first = await createLocalPr(repo, {
      title: "First",
      base: "main",
      head: "feat/prefix",
    });
    await assert.rejects(
      () => createLocalPr(repo, { title: "Second", base: "origin/main", head: "feat/prefix" }),
      new RegExp(`live loop ${first.id}.*update_local_pr`),
    );
  });

  test("create on head whose previous loop is archived still works", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/reuse"]);
    await writeFile(path.join(repo, "reuse.txt"), "r\n");
    git(["add", "."]);
    git(["commit", "-m", "reuse"]);
    const first = await createLocalPr(repo, {
      title: "Archived",
      base: "main",
      head: "feat/reuse",
    });
    const reuseSha = git(["rev-parse", "feat/reuse"]);
    await archiveLocalPr(repo, first.id);
    git(["checkout", "main"]);
    git(["branch", "feat/reuse", reuseSha]);
    git(["checkout", "feat/reuse"]);
    const second = await createLocalPr(repo, {
      title: "Fresh",
      base: "main",
      head: "feat/reuse",
    });
    assert.notEqual(second.id, first.id);
  });

  test("assertStoredBaseRefIsBranch fails ready for legacy SHA packet", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/ready-sha"]);
    await writeFile(path.join(repo, "ready.txt"), "r\n");
    git(["add", "."]);
    git(["commit", "-m", "ready"]);
    const pr = await createLocalPr(repo, { title: "Ready SHA", base: "main" });
    const mainSha = git(["rev-parse", "main"]);
    const dir = await prsDir(repo);
    const stored = JSON.parse(await readFile(prFile(dir, pr.id), "utf8")) as LocalPr;
    stored.baseRef = mainSha;
    await writeJsonFile(prFile(dir, pr.id), stored);
    await assert.rejects(
      () => setLocalPrStatus(repo, pr.id, "ready", { skipPreflight: true, ciSkipReason: "test" }),
      /is a commit/,
    );
  });

  test("getLocalPr normalizes stored origin/main baseRef for display", async () => {
    await freshRepo();
    git(["checkout", "-b", "feat/display"]);
    await writeFile(path.join(repo, "display.txt"), "d\n");
    git(["add", "."]);
    git(["commit", "-m", "display"]);
    const pr = await createLocalPr(repo, { title: "Display", base: "main", head: "feat/display" });
    const dir = await prsDir(repo);
    const stored = JSON.parse(await readFile(prFile(dir, pr.id), "utf8")) as LocalPr;
    stored.baseRef = "origin/main";
    await writeJsonFile(prFile(dir, pr.id), stored);
    const loaded = await getLocalPr(repo, pr.id);
    assert.equal(loaded.baseRef, "main");
  });

  test("suggestBranchForSha returns the branch when origin/HEAD would duplicate the name", async () => {
    await freshRepo();
    git(["branch", "-m", "main", "develop"]);
    const originTip = git(["rev-parse", "develop"]);
    const bare = await mkdtemp(path.join(tmpdir(), "prgenie-base-remote-"));
    git(["init", "--bare", "-b", "develop"], bare);
    git(["remote", "add", "origin", bare]);
    git(["push", "-u", "origin", "develop"]);
    git(["remote", "set-head", "origin", "develop"]);
    assert.equal(await suggestBranchForSha(repo, originTip), "develop");
    await assert.rejects(() => assertBaseRefIsBranch(repo, originTip), /is a commit.*`develop`/);
  });

  test("suggestBranchForSha returns nested remote branch names", async () => {
    await freshRepo();
    const bare = await mkdtemp(path.join(tmpdir(), "prgenie-base-remote-"));
    git(["init", "--bare", "-b", "main"], bare);
    git(["remote", "add", "origin", bare]);
    git(["push", "-u", "origin", "main"]);
    git(["remote", "set-head", "origin", "main"]);

    git(["checkout", "-b", "feat/foo"]);
    await writeFile(path.join(repo, "nested.txt"), "nested\n");
    git(["add", "."]);
    git(["commit", "-m", "nested feature"]);
    git(["push", "origin", "feat/foo"]);
    const featSha = git(["rev-parse", "feat/foo"]);

    git(["checkout", "-b", "release/1.2", "main"]);
    await writeFile(path.join(repo, "release.txt"), "rel\n");
    git(["add", "."]);
    git(["commit", "-m", "release cut"]);
    git(["push", "origin", "release/1.2"]);
    const releaseSha = git(["rev-parse", "release/1.2"]);

    assert.notEqual(featSha, releaseSha);
    assert.equal(await suggestBranchForSha(repo, featSha), "feat/foo");
    assert.equal(await suggestBranchForSha(repo, releaseSha), "release/1.2");
    await assert.rejects(
      () => assertBaseRefIsBranch(repo, featSha),
      /is a commit.*`feat\/foo`/,
    );
    await assert.rejects(
      () => assertBaseRefIsBranch(repo, releaseSha),
      /is a commit.*`release\/1\.2`/,
    );
  });
});
