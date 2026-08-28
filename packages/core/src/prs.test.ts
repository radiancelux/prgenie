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
  findLocalPrForCurrentBranch,
  formatReviewInbox,
  getLocalPr,
  getLocalPrDiff,
  listLocalPrs,
  listWorktrees,
  pendingReviewComments,
  setLocalPrStatus,
  shouldSpawnReviewer,
  markReviewRequested,
  updateLocalPr,
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
  const created = await createLocalPr(repo, {
    title: "Add widget",
    body: "Adds widget.txt so the playground has a diff.",
    base: "main",
  });
  assert.match(created.id, /^lp-[0-9a-f]{8}$/);
  assert.equal(created.status, "draft");
  assert.equal(created.headRef, "feat/widget");
  assert.equal(created.baseRef, "main");
  assert.match(created.body, /widget\.txt/);
  assert.ok(created.worktreePath);
  assert.equal(path.basename(created.worktreePath), path.basename(repo));

  const listed = await listLocalPrs(repo);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const updated = await updateLocalPr(repo, created.id, {
    body: "## Summary\n- Add widget.txt\n\n## Test\n- Open the loop diff.",
  });
  assert.match(updated.body, /## Summary/);

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
  assert.equal(commented.comments[0].role, "human");

  const fetched = await getLocalPr(repo, pr.id.slice(0, 6));
  assert.equal(fetched.id, pr.id);
});

test("reviewer comments request changes; agent replies do not", async () => {
  const pr = await createLocalPr(repo, { title: "Roles", base: "main" });
  const reviewed = await addLocalPrComment(repo, pr.id, "Missing tests.", {
    role: "reviewer",
    author: "review-agent",
  });
  assert.equal(reviewed.status, "changes_requested");
  assert.equal(reviewed.comments[0].role, "reviewer");
  assert.equal(pendingReviewComments(reviewed).length, 1);

  const replied = await addLocalPrComment(repo, pr.id, "Added widget.test.ts.", {
    role: "agent",
  });
  assert.equal(replied.status, "changes_requested");
  assert.equal(pendingReviewComments(replied).length, 0);

  const followup = await addLocalPrComment(repo, pr.id, "Also document the flag.", {
    path: "widget.txt",
    line: 1,
  });
  assert.equal(pendingReviewComments(followup).length, 1);
  const inbox = formatReviewInbox(followup);
  assert.ok(inbox);
  assert.match(inbox, /Human \(PR Genie Test\)/);
  assert.match(inbox, /Also document the flag/);
  assert.match(inbox, /@ widget\.txt:1/);
});

test("findLocalPrForCurrentBranch prefers changes_requested", async () => {
  git(["checkout", "feat/widget"]);
  const ready = await createLocalPr(repo, { title: "Ready twin", base: "main" });
  await setLocalPrStatus(repo, ready.id, "ready");
  const blocked = await createLocalPr(repo, { title: "Blocked twin", base: "main" });
  await addLocalPrComment(repo, blocked.id, "Fix the widget.", { role: "reviewer" });
  const found = await findLocalPrForCurrentBranch(repo);
  assert.ok(found);
  assert.equal(found.id, blocked.id);
  assert.equal(found.status, "changes_requested");
});

test("parallel reviewer comments both survive", async () => {
  const pr = await createLocalPr(repo, { title: "Lock", base: "main" });
  await Promise.all([
    addLocalPrComment(repo, pr.id, "First finding.", { role: "reviewer", author: "a" }),
    addLocalPrComment(repo, pr.id, "Second finding.", { role: "reviewer", author: "b" }),
  ]);
  const fresh = await getLocalPr(repo, pr.id);
  assert.equal(fresh.comments.length, 2);
  const bodies = fresh.comments.map((c) => c.body).sort();
  assert.deepEqual(bodies, ["First finding.", "Second finding."]);
});

test("captureAgentWork skips when HEAD is not ahead of base", async () => {
  git(["checkout", "main"]);
  const skipped = await captureAgentWork(repo);
  assert.equal(skipped.action, "skipped");
});

test("captureAgentWork creates then updates a loop for the same branch", async () => {
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

test("reviewer Task is requested once per loop HEAD", async () => {
  const pr = await createLocalPr(repo, { title: "Spawn", base: "main" });
  const ready = await setLocalPrStatus(repo, pr.id, "ready");
  assert.equal(shouldSpawnReviewer(ready), true);
  const marked = await markReviewRequested(repo, pr.id);
  assert.equal(shouldSpawnReviewer(marked), false);
  assert.equal(marked.reviewRequestedSha, marked.headSha);
});

test("a loop whose branch is not checked out gets a sibling worktree", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, {
    title: "Widget sibling",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  const trees = await listWorktrees(repo);
  assert.ok(trees.some((t) => t.branch === "feat/widget"));
  try {
    git(["worktree", "remove", "--force", "--", pr.worktreePath]);
  } catch {
    // temp leftover
  }
});

