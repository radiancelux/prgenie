import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  addLocalPrComment,
  createLocalPr,
  captureAgentWork,
  getLocalPr,
  getLocalPrDiff,
  listLocalPrs,
  listWorktrees,
  setLocalPrStatus,
} from "./index.js";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-"));
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

test("lists the main worktree", async () => {
  const trees = await listWorktrees(repo);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].branch, "feat/widget");
});

test("creates, lists, and approves a local PR", async () => {
  const created = await createLocalPr(repo, { title: "Add widget", base: "main" });
  assert.match(created.id, /^lp-[0-9a-f]{8}$/);
  assert.equal(created.status, "draft");
  assert.equal(created.headRef, "feat/widget");
  assert.equal(created.baseRef, "main");

  const listed = await listLocalPrs(repo);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const diff = await getLocalPrDiff(repo, created.id, { stat: true });
  assert.match(diff, /widget\.txt/);

  const approved = await setLocalPrStatus(repo, created.id, "approved");
  assert.equal(approved.status, "approved");

  const head = git(["rev-parse", `refs/local-pr/${created.id}/head`]);
  const base = git(["rev-parse", `refs/local-pr/${created.id}/base`]);
  assert.equal(head, created.headSha);
  assert.equal(base.length, 40);
});

test("comments move ready PRs back to changes_requested", async () => {
  const pr = await createLocalPr(repo, { title: "Second", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  const commented = await addLocalPrComment(repo, pr.id, "Please rename the file.");
  assert.equal(commented.status, "changes_requested");
  assert.equal(commented.comments.length, 1);

  const fetched = await getLocalPr(repo, pr.id.slice(0, 6));
  assert.equal(fetched.id, pr.id);
});

test("captureAgentWork skips when HEAD is not ahead of base", async () => {
  git(["checkout", "main"]);
  const skipped = await captureAgentWork(repo);
  assert.equal(skipped.action, "skipped");
});

test("captureAgentWork creates then updates a packet for the same branch", async () => {
  git(["checkout", "-b", "feat/capture"]);
  await writeFile(path.join(repo, "capture.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-m", "capture one"]);

  const first = await captureAgentWork(repo, {
    title: "From subagent",
    source: { kind: "subagent", subagentType: "generalPurpose", task: "add capture" },
  });
  assert.equal(first.action, "created");
  assert.equal(first.pr?.source?.kind, "subagent");

  await writeFile(path.join(repo, "capture.txt"), "two\n");
  git(["add", "."]);
  git(["commit", "-m", "capture two"]);

  const second = await captureAgentWork(repo, {
    title: "From subagent",
    source: { kind: "subagent", subagentType: "generalPurpose", task: "add capture" },
  });
  assert.equal(second.action, "updated");
  assert.equal(second.pr?.id, first.pr?.id);
});

