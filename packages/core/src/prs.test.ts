import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  addLocalPrComment,
  addressLocalPrComment,
  addressedReviewComments,
  archiveLoopsMergedOnGithub,
  createLocalPr,
  captureAgentWork,
  commentThreads,
  completeLocalPrReview,
  exportPushRefspec,
  findLocalPrForCurrentBranch,
  formatReviewInbox,
  getLocalPr,
  getLocalPrDiff,
  isArchivedPr,
  listLocalPrs,
  listWorktrees,
  pruneArchivedLoopWorktree,
  releaseArchivedLoop,
  sameFsPath,
  ensureWorktreeForLoop,
  pendingReviewComments,
  resolveLocalPrComment,
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
  assert.equal(isArchivedPr(approved), true);
  const stillThere = await getLocalPr(repo, created.id);
  assert.equal(stillThere.status, "approved");
  assert.ok((await listLocalPrs(repo)).some((p) => p.id === created.id));

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

  const replied = await addLocalPrComment(repo, pr.id, "Working on it.", {
    role: "agent",
  });
  assert.equal(replied.status, "changes_requested");
  assert.equal(pendingReviewComments(replied).length, 1);

  const followup = await addLocalPrComment(repo, pr.id, "Also document the flag.", {
    path: "widget.txt",
    line: 1,
  });
  assert.equal(pendingReviewComments(followup).length, 2);
  const inbox = formatReviewInbox(followup);
  assert.ok(inbox);
  assert.match(inbox, /Human \(PR Genie Test\)/);
  assert.match(inbox, /Also document the flag/);
  assert.match(inbox, /@ widget\.txt:1/);
  assert.match(inbox, /\[c-/);

  const threads = commentThreads(followup.comments);
  const finding = threads.find((t) => t.root.body === "Missing tests.");
  assert.ok(finding);
  assert.equal(finding.replies.some((r) => r.body === "Working on it."), true);
});

test("address_comment marks a finding addressed; reviewer resolve can hand off to human", async () => {
  const pr = await createLocalPr(repo, { title: "Resolve", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  const first = await addLocalPrComment(repo, pr.id, "Missing tests.", {
    role: "reviewer",
    author: "review-agent",
  });
  const second = await addLocalPrComment(repo, pr.id, "Rename the file.", {
    role: "reviewer",
    author: "review-agent",
  });
  assert.equal(pendingReviewComments(second).length, 2);
  const addressed = await addressLocalPrComment(
    repo,
    pr.id,
    first.comments[0].id,
    "Added widget.test.ts.",
  );
  assert.equal(addressed.status, "changes_requested");
  assert.equal(pendingReviewComments(addressed).length, 1);
  assert.equal(addressedReviewComments(addressed).length, 1);
  assert.equal(pendingReviewComments(addressed)[0].body, "Rename the file.");
  const reply = addressed.comments.find((c) => c.replyTo === first.comments[0].id);
  assert.ok(reply);
  assert.equal(reply.role, "agent");
  assert.equal(addressed.comments.find((c) => c.id === first.comments[0].id)?.status, "addressed");

  await addressLocalPrComment(repo, pr.id, second.comments[1].id, "Renamed the file.");
  const verified = await resolveLocalPrComment(
    repo,
    pr.id,
    first.comments[0].id,
    "Tests look good.",
  );
  assert.equal(verified.status, "changes_requested");
  const done = await completeLocalPrReview(repo, pr.id);
  assert.equal(done.status, "reviewed");
  assert.equal(pendingReviewComments(done).length, 0);
  assert.equal(addressedReviewComments(done).length, 0);
});

test("complete_review with no findings is ready for human review", async () => {
  const pr = await createLocalPr(repo, { title: "Clean", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  const done = await completeLocalPrReview(repo, pr.id, { body: "LGTM" });
  assert.equal(done.status, "reviewed");
  assert.match(done.comments[0].body, /LGTM/);
  assert.equal(done.comments[0].status, "resolved");
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

test("status write overlapping a comment keeps the finding", async () => {
  const pr = await createLocalPr(repo, { title: "Status lock", base: "main" });
  await Promise.all([
    setLocalPrStatus(repo, pr.id, "ready"),
    addLocalPrComment(repo, pr.id, "Do not drop this.", { role: "reviewer" }),
  ]);
  const fresh = await getLocalPr(repo, pr.id);
  assert.equal(fresh.comments.length, 1);
  assert.equal(fresh.comments[0].body, "Do not drop this.");
});

test("export pushes the loop SHA, not cwd HEAD", () => {
  assert.equal(
    exportPushRefspec({ headSha: "abc123", headRef: "ui/loop-panel" }),
    "abc123:refs/heads/ui/loop-panel",
  );
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

test("approved loops stay readable but are not the current-branch loop", async () => {
  git(["checkout", "-b", "feat/archive"]);
  await writeFile(path.join(repo, "archive.txt"), "done\n");
  git(["add", "."]);
  git(["commit", "-m", "archive work"]);
  const pr = await createLocalPr(repo, { title: "Ship it", base: "main" });
  await setLocalPrStatus(repo, pr.id, "approved");
  const fetched = await getLocalPr(repo, pr.id);
  assert.equal(fetched.status, "approved");
  assert.equal(isArchivedPr(fetched), true);
  assert.ok((await listLocalPrs(repo)).some((p) => p.id === pr.id));
  const found = await findLocalPrForCurrentBranch(repo);
  assert.equal(found, null);
  const captured = await captureAgentWork(repo, { title: "Next loop" });
  assert.equal(captured.action, "created");
  assert.ok(captured.pr);
  assert.notEqual(captured.pr.id, pr.id);
});

test("pruneArchivedLoopWorktree removes a sibling .loops checkout", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, {
    title: "Prune sibling",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  const pruned = await pruneArchivedLoopWorktree(repo, pr);
  assert.equal(pruned, true);
  const trees = await listWorktrees(repo);
  assert.equal(
    trees.some((t) => sameFsPath(t.path, pr.worktreePath ?? "")),
    false,
  );
  const still = await getLocalPr(repo, pr.id);
  assert.equal(still.id, pr.id);
});

test("pruneArchivedLoopWorktree keeps the primary checkout", async () => {
  git(["checkout", "feat/widget"]);
  const pr = await createLocalPr(repo, { title: "Stay put", base: "main" });
  assert.ok(pr.worktreePath);
  assert.equal(path.basename(pr.worktreePath), path.basename(repo));
  const pruned = await pruneArchivedLoopWorktree(repo, pr);
  assert.equal(pruned, false);
  const still = await getLocalPr(repo, pr.id);
  assert.equal(still.id, pr.id);
});

test("releaseArchivedLoop checks the main workspace off the loop branch", async () => {
  git(["checkout", "feat/widget"]);
  const pr = await createLocalPr(repo, { title: "Leave main", base: "main" });
  assert.equal(path.basename(pr.worktreePath ?? ""), path.basename(repo));
  const released = await releaseArchivedLoop(repo, pr);
  assert.equal(released.checkedOutBase, true);
  assert.equal(released.prunedWorktree, false);
  assert.equal(released.reopen, false);
  assert.equal(git(["branch", "--show-current"]), "main");
  const still = await getLocalPr(repo, pr.id);
  assert.equal(still.id, pr.id);
});

test("releaseArchivedLoop does not delete a worktree this window is sitting on", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, {
    title: "Parked",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(pr.worktreePath);
  const parked = await releaseArchivedLoop(pr.worktreePath, pr);
  assert.equal(parked.reopen, true);
  assert.equal(parked.prunedWorktree, false);
  const trees = await listWorktrees(repo);
  assert.ok(trees.some((t) => sameFsPath(t.path, pr.worktreePath ?? "")));
  const cleaned = await releaseArchivedLoop(repo, pr);
  assert.equal(cleaned.prunedWorktree, true);
});

test("new loop does not reuse an archived .loops checkout", async () => {
  git(["checkout", "main"]);
  const old = await createLocalPr(repo, {
    title: "Archived sibling",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(old.worktreePath);
  assert.match(old.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  await setLocalPrStatus(repo, old.id, "approved");
  const parked = await releaseArchivedLoop(old.worktreePath, old);
  assert.equal(parked.reopen, true);
  assert.equal(parked.prunedWorktree, false);
  const next = await createLocalPr(repo, {
    title: "Fresh sibling",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(next.worktreePath);
  assert.match(next.worktreePath.replace(/\\/g, "/"), new RegExp(`${next.id}$`));
  assert.equal(sameFsPath(next.worktreePath, old.worktreePath ?? ""), false);
  const listed = await listLocalPrs(repo);
  const oldListed = listed.find((p) => p.id === old.id);
  const nextListed = listed.find((p) => p.id === next.id);
  assert.ok(nextListed?.worktreePath);
  assert.equal(sameFsPath(nextListed.worktreePath ?? "", next.worktreePath), true);
  if (oldListed?.worktreePath) {
    assert.equal(sameFsPath(oldListed.worktreePath, next.worktreePath), false);
  }
  await pruneArchivedLoopWorktree(repo, old, {
    keepPaths: next.worktreePath ? [next.worktreePath] : [],
  });
  const trees = await listWorktrees(repo);
  assert.ok(trees.some((t) => sameFsPath(t.path, next.worktreePath ?? "")));
});

test("ensureWorktreeForLoop does not attach to another loop's leftover .loops folder", async () => {
  git(["checkout", "main"]);
  const leftover = await createLocalPr(repo, {
    title: "Leftover folder",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(leftover.worktreePath);
  await setLocalPrStatus(repo, leftover.id, "approved");
  const parked = await releaseArchivedLoop(leftover.worktreePath, leftover);
  assert.equal(parked.reopen, true);
  const dest = await ensureWorktreeForLoop(
    repo,
    {
      id: "lp-aaaaaaaa",
      headRef: "feat/widget",
      headSha: leftover.headSha,
    },
    { liveLoopIds: [] },
  );
  assert.match(dest.replace(/\\/g, "/"), /lp-aaaaaaaa$/);
  assert.equal(sameFsPath(dest, leftover.worktreePath ?? ""), false);
});

test("a loop created on the base branch checks out a feature branch here", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Off main", base: "main" });
  assert.equal(pr.headRef, pr.id);
  assert.notEqual(pr.headRef, "main");
  assert.equal(git(["branch", "--show-current"]), pr.id);
  assert.equal(path.basename(pr.worktreePath ?? ""), path.basename(repo));
});

test("a peeled worktree is created on the loop branch, not detached", async () => {
  const headSha = git(["rev-parse", "HEAD"]);
  const dest = await ensureWorktreeForLoop(repo, {
    id: "lp-bbbbbbbb",
    headRef: "lp-bbbbbbbb",
    headSha,
  });
  assert.match(dest.replace(/\\/g, "/"), /lp-bbbbbbbb$/);
  const trees = await listWorktrees(repo);
  const extra = trees.find((t) => sameFsPath(t.path, dest));
  assert.equal(extra?.branch, "lp-bbbbbbbb");
  assert.equal(extra?.detached, false);
  git(["worktree", "remove", "--force", "--", dest]);
});

test("comments do not un-archive an approved loop", async () => {
  const pr = await createLocalPr(repo, { title: "Keep archived", base: "main" });
  await setLocalPrStatus(repo, pr.id, "approved");
  const after = await addLocalPrComment(repo, pr.id, "Late finding.", { role: "reviewer" });
  assert.equal(after.status, "approved");
  assert.equal(isArchivedPr(after), true);
  await assert.rejects(
    () => setLocalPrStatus(repo, pr.id, "changes_requested"),
    /archived/,
  );
});

test("archiveLoopsMergedOnGithub archives a loop whose GitHub PR is merged", async () => {
  const pr = await createLocalPr(repo, { title: "Merged on origin", base: "main" });
  assert.equal(isArchivedPr(pr), false);
  const ids = await archiveLoopsMergedOnGithub(repo, async (head) =>
    head === pr.headRef ? "MERGED" : null,
  );
  assert.ok(ids.includes(pr.id));
  assert.equal((await getLocalPr(repo, pr.id)).status, "approved");
});

