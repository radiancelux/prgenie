import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  addLocalPrComment,
  addressLocalPrComment,
  addressedReviewComments,
  archiveLoopsMergedOnGithub,
  createLocalPr,
  captureAgentWork,
  commentThreads,
  groupThreadsByRound,
  completeLocalPrReview,
  deleteLocalPr,
  deleteLocalPrComment,
  archiveLocalPr,
  clearArchivedLocalPrs,
  clearArchivedDiskFailure,
  editLocalPrComment,
  exportPushRefspec,
  findLocalPrForCurrentBranch,
  findLocalPrForCurrentWorktree,
  findPeelStashRef,
  formatReviewInbox,
  formatSpawnReviewer,
  getLocalPr,
  getLocalPrDiff,
  isArchivedPr,
  listCorruptLocalPrFiles,
  listLocalPrs,
  localPrMatchesSearch,
  listWorktrees,
  loopWorktreeIdentity,
  peelStashMessage,
  pruneArchivedLoopWorktree,
  pruneArchivedLoopWorktreeDetailed,
  pruneLoopWorktrees,
  refusePrimaryWorktreeIfParallel,
  releaseArchivedLoop,
  reopenLocalPr,
  sameFsPath,
  ensureWorktreeForLoop,
  pendingReviewComments,
  resolveLocalPrComment,
  setLocalPrStatus,
  shouldSpawnReviewer,
  markReviewRequested,
  markReviewerNotified,
  markReviewInterrupted,
  updateLocalPr,
  haltWatch,
  haltWatchRole,
  getRepoWatch,
  resumeWatch,
} from "./index.js";
import { prsDir, prFile, parseJsonObject, writeJsonFile } from "./store.js";
import type { LocalPr } from "./types.js";

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

beforeEach(async () => {
  if (!repo) return;
  const trees = await listWorktrees(repo);
  if (trees.some((t) => loopWorktreeIdentity(t.path))) {
    await pruneLoopWorktrees(repo);
  }
  try {
    git(["checkout", "feat/widget"]);
  } catch {
    git(["checkout", "-B", "feat/widget"]);
  }
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
  assert.match(created.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  assert.match(created.worktreePath.replace(/\\/g, "/"), new RegExp(`${created.id}$`));

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
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const commented = await addLocalPrComment(repo, pr.id, "Please rename the file.");
  assert.equal(commented.status, "changes_requested");
  assert.equal(commented.comments.length, 1);
  assert.equal(commented.comments[0].role, "human");

  const fetched = await getLocalPr(repo, pr.id.slice(0, 6));
  assert.equal(fetched.id, pr.id);
});

test("reviewer comments stay on ready until complete_review", async () => {
  const pr = await createLocalPr(repo, { title: "Roles", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const filed = await addLocalPrComment(repo, pr.id, "Missing tests.", {
    role: "reviewer",
    author: "review-agent",
  });
  assert.equal(filed.status, "ready");
  assert.equal(filed.comments[0].role, "reviewer");
  assert.equal(pendingReviewComments(filed).length, 1);
  assert.equal(formatReviewInbox(filed), null);

  const replied = await addLocalPrComment(repo, pr.id, "Working on it.", {
    role: "agent",
  });
  assert.equal(replied.status, "ready");
  assert.equal(pendingReviewComments(replied).length, 1);

  const followup = await addLocalPrComment(repo, pr.id, "Also document the flag.", {
    path: "widget.txt",
    line: 1,
  });
  assert.equal(followup.status, "changes_requested");
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
  assert.equal(
    finding.replies.some((r) => r.body === "Working on it."),
    true,
  );
});

test("groupThreadsByRound splits on Review requested roots (RAD-114)", () => {
  const mk = (
    id: string,
    body: string,
    role: "human" | "agent" | "reviewer",
    status: "open" | "addressed" | "resolved" = "open",
  ) => ({
    id,
    body,
    role,
    status,
    author: role,
    createdAt: "2026-09-22T00:00:00.000Z",
  });
  const rounds = groupThreadsByRound(
    commentThreads([
      mk("c-rr1", "Review requested.", "agent", "resolved"),
      mk("c-f1", "Missing tests.", "reviewer", "resolved"),
      { ...mk("c-a1", "Fixed tests.", "agent", "resolved"), replyTo: "c-f1" },
      mk("c-rr2", "Review requested.", "agent", "resolved"),
      mk("c-f2", "Still flaky.", "reviewer", "open"),
    ]),
  );
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0]!.round, 1);
  assert.equal(rounds[0]!.resolvedCount, 1);
  assert.equal(rounds[0]!.openCount, 0);
  assert.equal(rounds[1]!.round, 2);
  assert.equal(rounds[1]!.openCount, 1);
  assert.equal(rounds[1]!.resolvedCount, 0);
  assert.equal(
    rounds[1]!.threads.some((t) => t.root.body === "Still flaky."),
    true,
  );
});

test("groupThreadsByRound keeps pre-review comments in round 1", () => {
  const mk = (
    id: string,
    body: string,
    role: "human" | "agent" | "reviewer",
    status: "open" | "addressed" | "resolved" = "open",
  ) => ({
    id,
    body,
    role,
    status,
    author: role,
    createdAt: "2026-09-22T00:00:00.000Z",
  });
  const rounds = groupThreadsByRound(
    commentThreads([
      mk("c-h1", "Please also rename the helper.", "human", "open"),
      mk("c-rr1", "Review requested.", "agent", "resolved"),
      mk("c-f1", "Missing tests.", "reviewer", "open"),
    ]),
  );
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.threads.length, 3);
  assert.equal(rounds[0]!.openCount, 2);
});

test("reviewer comments stay on review_interrupted until complete_review", async () => {
  const pr = await createLocalPr(repo, { title: "Interrupted review lane", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  await markReviewInterrupted(repo, pr.id, { reason: "auth failure" });
  const filed = await addLocalPrComment(repo, pr.id, "Missing tests.", {
    role: "reviewer",
    author: "review-agent",
  });
  assert.equal(filed.status, "review_interrupted");
  assert.equal(filed.comments.filter((c) => c.role === "reviewer" && !c.replyTo).length, 1);
  assert.equal(pendingReviewComments(filed).length, 1);
  assert.equal(formatReviewInbox(filed), null);

  const replied = await addLocalPrComment(repo, pr.id, "Working on it.", {
    role: "agent",
  });
  assert.equal(replied.status, "review_interrupted");
  assert.equal(pendingReviewComments(replied).length, 1);
});

test("address_comment marks a finding addressed; reviewer resolve can hand off to human", async () => {
  const pr = await createLocalPr(repo, { title: "Resolve", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const first = await addLocalPrComment(repo, pr.id, "Missing tests.", {
    role: "reviewer",
    author: "review-agent",
  });
  const second = await addLocalPrComment(repo, pr.id, "Rename the file.", {
    role: "reviewer",
    author: "review-agent",
  });
  assert.equal(second.status, "ready");
  const submitted = await completeLocalPrReview(repo, pr.id);
  assert.equal(submitted.status, "changes_requested");
  assert.equal(pendingReviewComments(submitted).length, 2);
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
  const handedBack = await getLocalPr(repo, pr.id);
  assert.equal(handedBack.status, "ready");
  assert.equal(pendingReviewComments(handedBack).length, 0);
  assert.match(handedBack.comments.at(-1)?.body ?? "", /Review requested/i);
  const verified = await resolveLocalPrComment(
    repo,
    pr.id,
    first.comments[0].id,
    "Tests look good.",
  );
  assert.equal(verified.status, "ready");
  const done = await completeLocalPrReview(repo, pr.id);
  assert.equal(done.status, "reviewed");
  assert.equal(pendingReviewComments(done).length, 0);
  assert.equal(addressedReviewComments(done).length, 0);
});

test("complete_review with no findings clears review for the export gate", async () => {
  const pr = await createLocalPr(repo, { title: "Clean", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const done = await completeLocalPrReview(repo, pr.id, { body: "LGTM" });
  assert.equal(done.status, "reviewed");
  assert.match(done.comments[0].body, /LGTM/);
  assert.equal(done.comments[0].status, "resolved");
});

test("complete_review default copy is review-cleared, not ready-for-human", async () => {
  const pr = await createLocalPr(repo, { title: "Default copy", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const done = await completeLocalPrReview(repo, pr.id);
  assert.equal(done.status, "reviewed");
  assert.match(done.comments[0].body, /Review cleared\. Steward will run the export gate/);
  assert.doesNotMatch(done.comments[0].body, /ready for human|Push to origin/i);
});

test("complete_review with findings hands the loop to the implementor", async () => {
  const pr = await createLocalPr(repo, { title: "Batch", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  await addLocalPrComment(repo, pr.id, "Missing tests.", { role: "reviewer" });
  assert.equal((await getLocalPr(repo, pr.id)).status, "ready");
  const done = await completeLocalPrReview(repo, pr.id);
  assert.equal(done.status, "changes_requested");
  assert.equal(pendingReviewComments(done).length, 1);
  assert.match(done.comments.at(-1)?.body ?? "", /implementor/);
});

test("addressing the last open finding sets ready for the next review", async () => {
  const pr = await createLocalPr(repo, { title: "Handoff", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const filed = await addLocalPrComment(repo, pr.id, "Missing tests.", { role: "reviewer" });
  await completeLocalPrReview(repo, pr.id);
  const first = await addressLocalPrComment(repo, pr.id, filed.comments[0].id, "Added tests.");
  assert.equal(first.status, "ready");
  assert.equal(pendingReviewComments(first).length, 0);
  assert.equal(addressedReviewComments(first).length, 1);
  assert.equal(
    first.comments.some((c) => c.role === "agent" && /review requested/i.test(c.body)),
    true,
  );
});

test("resolve_comment on ready does not finish the review", async () => {
  const pr = await createLocalPr(repo, { title: "Stay ready", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const filed = await addLocalPrComment(repo, pr.id, "Missing tests.", { role: "reviewer" });
  await completeLocalPrReview(repo, pr.id);
  await addressLocalPrComment(repo, pr.id, filed.comments[0].id, "Added tests.");
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const verified = await resolveLocalPrComment(
    repo,
    pr.id,
    filed.comments[0].id,
    "Tests look good.",
  );
  assert.equal(verified.status, "ready");
  const done = await completeLocalPrReview(repo, pr.id);
  assert.equal(done.status, "reviewed");
});

test("findLocalPrForCurrentWorktree does not grab another loop's inbox", async () => {
  git(["checkout", "feat/widget"]);
  const here = await createLocalPr(repo, { title: "This checkout", base: "main" });
  await setLocalPrStatus(repo, here.id, "ready", { ciSkipReason: "test" });
  assert.equal(here.headRef, "feat/widget");
  assert.ok(here.worktreePath);
  git(["checkout", "-b", "feat/other-inbox"]);
  const other = await createLocalPr(repo, { title: "Other inbox", base: "main" });
  await setLocalPrStatus(repo, other.id, "ready", { ciSkipReason: "test" });
  await addLocalPrComment(repo, other.id, "Fix other.", { role: "reviewer" });
  await completeLocalPrReview(repo, other.id);
  assert.equal((await getLocalPr(repo, other.id)).status, "changes_requested");
  const found = await findLocalPrForCurrentWorktree(here.worktreePath!);
  assert.ok(found);
  assert.equal(found.headRef, "feat/widget");
  assert.notEqual(found.id, other.id);
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
    setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" }),
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
  assert.ok(first.pr?.worktreePath);

  const work = first.pr.worktreePath;
  await writeFile(path.join(work, "capture.txt"), "two\n");
  git(["add", "."], work);
  git(["commit", "-m", "capture two"], work);

  const second = await captureAgentWork(work, {
    title: "From subagent",
    source: { kind: "subagent", subagentType: "generalPurpose", task: "add capture" },
  });
  assert.equal(second.action, "updated");
  assert.equal(second.pr?.id, first.pr?.id);
});

test("reviewer Task is requested once per loop HEAD", async () => {
  const pr = await createLocalPr(repo, { title: "Spawn", base: "main" });
  const ready = await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  // Drift baseline is armed; spawn notify is still pending for this HEAD.
  assert.equal(ready.reviewRequestedSha, ready.headSha);
  assert.equal(ready.reviewerNotifiedSha, null);
  assert.equal(shouldSpawnReviewer(ready), true);
  const notified = await markReviewerNotified(repo, pr.id);
  assert.equal(shouldSpawnReviewer(notified), false);
  assert.equal(notified.reviewerNotifiedSha, notified.headSha);
  const spawnCopy = formatSpawnReviewer(ready);
  assert.match(spawnCopy, /\/steward/);
  assert.match(spawnCopy, /Do not claim_review/);
  assert.match(spawnCopy, /Do not Task a reviewer/);
  assert.doesNotMatch(spawnCopy, /Then Task one generalPurpose reviewer/);
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
  git(["checkout", "-b", "feat/after-archive"]);
  await writeFile(path.join(repo, "next.txt"), "next\n");
  git(["add", "."]);
  git(["commit", "-m", "next loop work"]);
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

test("prune clears orphan leftover directory after git link is gone (RAD-95)", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, {
    title: "Orphan leftover",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(pr.worktreePath);
  // Simulate dogfood: git unregisters the worktree but leaves the folder.
  git(["worktree", "remove", "--force", "--", pr.worktreePath]);
  await mkdir(pr.worktreePath, { recursive: true });
  await writeFile(path.join(pr.worktreePath, "leftover.txt"), "still here\n");
  const detailed = await pruneArchivedLoopWorktreeDetailed(repo, pr);
  assert.equal(detailed.pruned, true);
  assert.equal(detailed.leftoverPath, null);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(pr.worktreePath), false);
});

test("requireGithubBindForReviewed refuses unbound repos (RAD-95)", async () => {
  git(["checkout", "main"]);
  const { requireGithubBindForReviewed } = await import("./github-ops.js");
  await assert.rejects(() => requireGithubBindForReviewed(repo), /unbound|gh use/i);
});

test("pruneArchivedLoopWorktree never removes the primary checkout", async () => {
  git(["checkout", "feat/widget"]);
  const pr = await createLocalPr(repo, { title: "Stay put", base: "main" });
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  const pruned = await pruneArchivedLoopWorktree(repo, pr);
  assert.equal(pruned, true);
  const trees = await listWorktrees(repo);
  assert.ok(trees.some((t) => sameFsPath(t.path, repo)));
  assert.equal(
    trees.some((t) => sameFsPath(t.path, pr.worktreePath ?? "")),
    false,
  );
  const still = await getLocalPr(repo, pr.id);
  assert.equal(still.id, pr.id);
});

test("releaseArchivedLoop checks the main workspace off the loop branch", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, {
    title: "Leave main",
    base: "main",
    head: "feat/widget",
  });
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  git(["worktree", "remove", "--force", "--", pr.worktreePath]);
  git(["checkout", "feat/widget"]);
  const released = await releaseArchivedLoop(repo, { ...pr, worktreePath: repo });
  assert.equal(released.checkedOutBase, true);
  // Worktree already force-removed — end state is pruned (RAD-95).
  assert.equal(released.prunedWorktree, true);
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

test("a loop created on the base branch peels an exclusive feature worktree", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Off main", base: "main" });
  assert.equal(pr.headRef, pr.id);
  assert.notEqual(pr.headRef, "main");
  assert.equal(git(["branch", "--show-current"]), "main");
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), new RegExp(`${pr.id}$`));
  const trees = await listWorktrees(repo);
  const exclusive = trees.find((t) => sameFsPath(t.path, pr.worktreePath ?? ""));
  assert.equal(exclusive?.branch, pr.id);
  assert.equal(exclusive?.detached, false);
});

test("every live loop gets an exclusive .loops worktree even when the branch is on primary", async () => {
  git(["checkout", "feat/widget"]);
  const pr = await createLocalPr(repo, { title: "Exclusive peel", base: "main" });
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), new RegExp(`${pr.id}$`));
  assert.equal(sameFsPath(pr.worktreePath, repo), false);
  assert.equal(git(["branch", "--show-current"]), "main");
  const trees = await listWorktrees(repo);
  const exclusive = trees.find((t) => sameFsPath(t.path, pr.worktreePath ?? ""));
  assert.equal(exclusive?.branch, "feat/widget");
});

test("dirty primary peel stashes by message and restores into the exclusive worktree", async () => {
  git(["checkout", "feat/widget"]);
  // Unrelated stash stays at stash@{0} so a naive pop would steal the wrong entry.
  await writeFile(path.join(repo, "unrelated-stash.txt"), "keep me\n");
  git(["add", "unrelated-stash.txt"]);
  git(["stash", "push", "-m", "unrelated-other-work"]);
  await writeFile(path.join(repo, "peel-dirty.txt"), "carry into exclusive\n");

  const pr = await createLocalPr(repo, { title: "Dirty peel", base: "main" });
  assert.ok(pr.worktreePath);
  assert.match(pr.worktreePath.replace(/\\/g, "/"), /\.loops\//);
  assert.equal(git(["branch", "--show-current"]), "main");
  assert.match(
    (await readFile(path.join(pr.worktreePath, "peel-dirty.txt"), "utf8")).replace(/\r\n/g, "\n"),
    /^carry into exclusive\n$/,
  );
  // Peel stash consumed; unrelated stash still present.
  assert.equal(await findPeelStashRef(repo, pr.id), null);
  const stashList = git(["stash", "list"]);
  assert.match(stashList, /unrelated-other-work/);
  assert.doesNotMatch(
    stashList,
    new RegExp(peelStashMessage(pr.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(git(["status", "--porcelain", "--", "peel-dirty.txt"], repo).trim(), "");
  git(["stash", "drop"]);
});

test("refusePrimaryWorktreeIfParallel errors when primary bind would share with another live loop", () => {
  assert.throws(
    () => refusePrimaryWorktreeIfParallel(repo, repo, "lp-aaaaaaaa", ["lp-bbbbbbbb"]),
    /Refusing to bind loop lp-aaaaaaaa to the primary checkout while other live loops exist \(lp-bbbbbbbb\)/,
  );
  assert.doesNotThrow(() =>
    refusePrimaryWorktreeIfParallel(repo, repo, "lp-aaaaaaaa", ["lp-aaaaaaaa"]),
  );
  assert.doesNotThrow(() =>
    refusePrimaryWorktreeIfParallel(
      path.join(repo + ".loops", "lp-aaaaaaaa"),
      repo,
      "lp-aaaaaaaa",
      ["lp-bbbbbbbb"],
    ),
  );
});

test("create refuses primary bind semantics by peeling a second live loop exclusively", async () => {
  git(["checkout", "main"]);
  const first = await createLocalPr(repo, {
    title: "First exclusive",
    base: "main",
    head: "feat/widget",
  });
  assert.match(first.worktreePath?.replace(/\\/g, "/") ?? "", /\.loops\//);
  git(["checkout", "-b", "feat/second"]);
  await writeFile(path.join(repo, "second.txt"), "two\n");
  git(["add", "."]);
  git(["commit", "-m", "second work"]);
  const second = await createLocalPr(repo, { title: "Second exclusive", base: "main" });
  assert.match(second.worktreePath?.replace(/\\/g, "/") ?? "", /\.loops\//);
  assert.equal(sameFsPath(second.worktreePath ?? "", repo), false);
  assert.equal(sameFsPath(second.worktreePath ?? "", first.worktreePath ?? ""), false);
  assert.equal(git(["branch", "--show-current"]), "main");
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
  await assert.rejects(() => setLocalPrStatus(repo, pr.id, "changes_requested"), /archived/);
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

test("complete_review does not un-archive an approved loop", async () => {
  const pr = await createLocalPr(repo, { title: "Stay approved", base: "main" });
  await setLocalPrStatus(repo, pr.id, "approved");
  const after = await completeLocalPrReview(repo, pr.id);
  assert.equal(after.status, "approved");
  assert.equal(isArchivedPr(after), true);
});

test("a long comment body is stored in full", async () => {
  const pr = await createLocalPr(repo, { title: "Long note", base: "main" });
  const body = `Reviewer finding \u2014 ${"n".repeat(8000)} \`complete_review\` before stop.`;
  const after = await addLocalPrComment(repo, pr.id, body, { role: "reviewer" });
  assert.equal(after.comments.at(-1)?.body, body);
  assert.equal((await getLocalPr(repo, pr.id)).comments.at(-1)?.body, body);
});

test("creating a loop resumes watch after an archived export halt", async () => {
  git(["checkout", "main"]);
  const shipped = await createLocalPr(repo, { title: "Already shipped", base: "main" });
  await setLocalPrStatus(repo, shipped.id, "approved");
  await haltWatch(repo, "export", shipped.id);
  assert.equal((await getRepoWatch(repo)).halted, true);
  const next = await createLocalPr(repo, { title: "Next after export", base: "main" });
  assert.equal((await getRepoWatch(repo)).halted, false);
  assert.equal((await getRepoWatch(repo)).reason, null);
  assert.ok(next.id);
});

test("creating a loop does not resume a stop halt", async () => {
  git(["checkout", "main"]);
  await haltWatch(repo, "stop");
  await createLocalPr(repo, { title: "After stop", base: "main" });
  const watch = await getRepoWatch(repo);
  assert.equal(watch.halted, true);
  assert.equal(watch.reason, "stop");
  await resumeWatch(repo);
});

test("creating a loop does not resume an inbox-only stop halt", async () => {
  git(["checkout", "main"]);
  await haltWatchRole(repo, "inbox", "stop");
  await createLocalPr(repo, { title: "After inbox stop", base: "main" });
  const watch = await getRepoWatch(repo);
  assert.equal(watch.inbox.halted, true);
  assert.equal(watch.queue.halted, false);
  await resumeWatch(repo);
});

test("creating a loop resumes export lanes even if the other lane is stop-halted", async () => {
  git(["checkout", "main"]);
  const shipped = await createLocalPr(repo, { title: "Shipped then cap", base: "main" });
  await setLocalPrStatus(repo, shipped.id, "approved");
  await haltWatch(repo, "export", shipped.id);
  await haltWatchRole(repo, "inbox", "stop");
  await createLocalPr(repo, { title: "Next after mixed halt", base: "main" });
  const watch = await getRepoWatch(repo);
  assert.equal(watch.inbox.halted, true);
  assert.equal(watch.inbox.reason, "stop");
  assert.equal(watch.queue.halted, false);
  await resumeWatch(repo);
});

test("creating a loop does not resume export halt while that id is still live", async () => {
  git(["checkout", "main"]);
  const live = await createLocalPr(repo, { title: "Export in flight", base: "main" });
  await haltWatch(repo, "export", live.id);
  await createLocalPr(repo, { title: "Sibling during export", base: "main" });
  const watch = await getRepoWatch(repo);
  assert.equal(watch.halted, true);
  assert.equal(watch.reason, "export");
  await resumeWatch(repo);
});

test("a missing export id is treated as shipped when creating the next loop", async () => {
  git(["checkout", "main"]);
  await haltWatch(repo, "export", "lp-gonegone");
  await createLocalPr(repo, { title: "After missing export id", base: "main" });
  assert.equal((await getRepoWatch(repo)).halted, false);
});

test("ready handoff arms reviewRequestedSha for the drift guard", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Arm baseline", base: "main" });
  const ready = await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  assert.equal(ready.reviewRequestedSha, ready.headSha);
  assert.ok(ready.reviewRequestedSha);

  await setLocalPrStatus(repo, pr.id, "changes_requested");
  const filed = await addLocalPrComment(repo, pr.id, "Fix me.", { role: "reviewer" });
  await completeLocalPrReview(repo, pr.id);
  const handed = await addressLocalPrComment(repo, pr.id, filed.comments[0].id, "Fixed.");
  assert.equal(handed.status, "ready");
  assert.equal(handed.reviewRequestedSha, handed.headSha);
});

test("complete_review refuses when HEAD moved after Review requested", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Drift guard", base: "main" });
  assert.ok(pr.worktreePath);
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const marked = await markReviewRequested(repo, pr.id);
  await writeFile(path.join(pr.worktreePath, "drift.txt"), "moved\n");
  git(["add", "drift.txt"], pr.worktreePath);
  git(["commit", "-m", "move head after review requested"], pr.worktreePath);
  await assert.rejects(
    () => completeLocalPrReview(repo, marked.id),
    /HEAD moved since Review requested/,
  );
  assert.equal((await getLocalPr(repo, marked.id)).status, "ready");
  const forced = await completeLocalPrReview(repo, marked.id, { allowDrift: true });
  assert.equal(forced.headDrift, true);
  assert.equal(forced.status, "reviewed");
});

test("reviewer finding on reviewed flips to changes_requested", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Late finding", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  await completeLocalPrReview(repo, pr.id);
  assert.equal((await getLocalPr(repo, pr.id)).status, "reviewed");
  const after = await addLocalPrComment(repo, pr.id, "Missed this.", { role: "reviewer" });
  assert.equal(after.status, "changes_requested");
  assert.equal(pendingReviewComments(after).length, 1);
});

test("getLocalPrDiff supports paths filter", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Paths filter", base: "main" });
  assert.ok(pr.worktreePath);
  await writeFile(path.join(pr.worktreePath, "a.txt"), "a\n");
  await writeFile(path.join(pr.worktreePath, "b.txt"), "b\n");
  git(["add", "a.txt", "b.txt"], pr.worktreePath);
  git(["commit", "-m", "two files"], pr.worktreePath);
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const onlyA = await getLocalPrDiff(repo, pr.id, { paths: ["a.txt"] });
  assert.match(onlyA, /a\.txt/);
  assert.doesNotMatch(onlyA, /b\.txt/);
});

test("listCorruptLocalPrFiles names unparsable packets", async () => {
  const dir = await prsDir(repo);
  const bad = path.join(dir, "lp-badbadad.json");
  await writeFile(bad, "{not-json");
  const corrupt = await listCorruptLocalPrFiles(repo);
  assert.ok(corrupt.some((f) => f.endsWith("lp-badbadad.json")));
  await rm(bad, { force: true });
});

test("reopen and delete local PR", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Reopen me", base: "main" });
  await setLocalPrStatus(repo, pr.id, "approved");
  const reopened = await reopenLocalPr(repo, pr.id);
  assert.equal(reopened.status, "changes_requested");
  assert.equal(isArchivedPr(reopened), false);
  const deleted = await deleteLocalPr(repo, pr.id);
  assert.equal(deleted.deleted, true);
  await assert.rejects(() => getLocalPr(repo, pr.id), /not found/i);
});

test("archiveLocalPr prunes worktree and deletes local loop branch (RAD-130)", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Archive cleanup", base: "main" });
  assert.ok(pr.worktreePath);
  const headRef = pr.headRef;
  const archived = await archiveLocalPr(repo, pr.id);
  assert.equal(archived.pr.status, "approved");
  assert.equal(archived.finalize.prunedWorktree, true);
  assert.equal(archived.finalize.deletedBranch, true);
  const trees = await listWorktrees(repo);
  assert.equal(
    trees.some((t) => sameFsPath(t.path, pr.worktreePath ?? "")),
    false,
  );
  assert.throws(() =>
    execFileSync("git", ["rev-parse", "--verify", `refs/heads/${headRef}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    }),
  );
  // Packet remains for reopen / clear
  const still = await getLocalPr(repo, pr.id);
  assert.equal(still.status, "approved");
  // Reopen recreates branch + worktree from packet tip (not leftover folder)
  const reopened = await reopenLocalPr(repo, pr.id);
  assert.equal(reopened.status, "changes_requested");
  assert.ok(reopened.worktreePath);
  assert.match(reopened.worktreePath.replace(/\\/g, "/"), /\.loops\//);
});

test("archived refresh keeps frozen head; reopen restores loop branch (RAD-130)", async () => {
  const { refreshLocalPrHead } = await import("./prs.js");
  git(["checkout", "main"]);
  await writeFile(path.join(repo, "freeze-arch.txt"), "loop tip\n");
  git(["add", "."]);
  git(["commit", "-m", "freeze arch tip"]);
  const pr = await createLocalPr(repo, { title: "Freeze archived head", base: "main" });
  const frozenRef = pr.headRef;
  const frozenSha = pr.headSha;
  assert.match(frozenRef, /^lp-/);

  await archiveLocalPr(repo, pr.id);

  // Primary stays on / moves with main — refresh must not adopt it.
  git(["checkout", "main"]);
  await writeFile(path.join(repo, "main-after-archive.txt"), "main moved\n");
  git(["add", "."]);
  git(["commit", "-m", "main after archive"]);
  const mainSha = git(["rev-parse", "HEAD"]);
  assert.notEqual(mainSha, frozenSha);

  const refreshed = await refreshLocalPrHead(repo, pr.id);
  assert.equal(refreshed.status, "approved");
  assert.equal(refreshed.headRef, frozenRef);
  assert.equal(refreshed.headSha, frozenSha);
  assert.notEqual(refreshed.headRef, "main");

  // Second poll (getLocalPrNameStatus path) still frozen.
  const polled = await refreshLocalPrHead(repo, pr.id);
  assert.equal(polled.headRef, frozenRef);
  assert.equal(polled.headSha, frozenSha);

  const reopened = await reopenLocalPr(repo, pr.id);
  assert.equal(reopened.status, "changes_requested");
  assert.equal(reopened.headRef, frozenRef);
  assert.equal(reopened.headSha, frozenSha);
  assert.ok(reopened.worktreePath);
  assert.match(reopened.worktreePath.replace(/\\/g, "/"), new RegExp(`\\.loops[/\\\\]${pr.id}$`));
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], reopened.worktreePath), frozenRef);
  assert.equal(git(["rev-parse", "HEAD"], reopened.worktreePath), frozenSha);
  execFileSync("git", ["rev-parse", "--verify", `refs/heads/${frozenRef}`], {
    cwd: repo,
    encoding: "utf8",
  });
});

test("clear archived after refresh does not try to delete main (RAD-130)", async () => {
  const { refreshLocalPrHead } = await import("./prs.js");
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/clear-after-refresh"]);
  await writeFile(path.join(repo, "clear-refresh.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "clear refresh tip"]);
  const pr = await createLocalPr(repo, { title: "Clear after refresh", base: "main" });
  const frozenRef = pr.headRef;
  await archiveLocalPr(repo, pr.id);
  git(["checkout", "main"]);
  // Sidebar / show / steward_next all refresh — must leave headRef as lp-*, not main.
  await refreshLocalPrHead(repo, pr.id);
  const after = await getLocalPr(repo, pr.id);
  assert.equal(after.headRef, frozenRef);
  assert.notEqual(after.headRef, "main");

  const result = await clearArchivedLocalPrs(repo);
  assert.equal(result.failed.length, 0);
  assert.ok(result.cleared.includes(pr.id));
  assert.equal(
    result.failed.some((f) => /refusing to delete (base|protected) branch main/i.test(f.error)),
    false,
  );
});

test("clearArchivedLocalPrs removes packets worktrees and local branches (RAD-130)", async () => {
  git(["checkout", "main"]);
  const a = await createLocalPr(repo, { title: "Clear A", base: "main" });
  const b = await createLocalPr(repo, { title: "Clear B", base: "main" });
  await archiveLocalPr(repo, a.id);
  await archiveLocalPr(repo, b.id);
  const result = await clearArchivedLocalPrs(repo);
  assert.equal(result.failed.length, 0);
  assert.ok(result.cleared.includes(a.id));
  assert.ok(result.cleared.includes(b.id));
  await assert.rejects(() => getLocalPr(repo, a.id), /not found/i);
  await assert.rejects(() => getLocalPr(repo, b.id), /not found/i);
  const archivedLeft = (await listLocalPrs(repo)).filter(isArchivedPr);
  assert.equal(archivedLeft.length, 0);
});

test("clearArchivedDiskFailure fails closed when flags are false without error strings (RAD-130)", () => {
  const both = clearArchivedDiskFailure(
    {
      prunedWorktree: false,
      pruneError: null,
      worktreeLeftoverPath: "/repo.loops/lp-empty-err",
      deletedBranch: false,
      branch: "lp-empty-err",
      branchError: null,
    },
    "/fallback",
  );
  assert.ok(both);
  assert.equal(both.path, "/repo.loops/lp-empty-err");
  assert.match(both.error, /worktree not removed/);
  assert.match(both.error, /local branch lp-empty-err not deleted/);

  const pruneOnly = clearArchivedDiskFailure(
    {
      prunedWorktree: false,
      pruneError: "",
      worktreeLeftoverPath: null,
      deletedBranch: true,
      branch: "lp-ok",
      branchError: null,
    },
    "/fallback-path",
  );
  assert.ok(pruneOnly);
  assert.equal(pruneOnly.path, "/fallback-path");
  assert.equal(pruneOnly.error, "worktree not removed");

  const branchOnly = clearArchivedDiskFailure(
    {
      prunedWorktree: true,
      pruneError: null,
      worktreeLeftoverPath: null,
      deletedBranch: false,
      branch: null,
      branchError: "   ",
    },
    null,
  );
  assert.ok(branchOnly);
  assert.equal(branchOnly.error, "local loop branch not deleted");

  assert.equal(
    clearArchivedDiskFailure(
      {
        prunedWorktree: true,
        pruneError: null,
        worktreeLeftoverPath: null,
        deletedBranch: true,
        branch: "lp-ok",
        branchError: null,
      },
      null,
    ),
    null,
  );
});

test("edit and delete open findings", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, { title: "Comment edit", base: "main" });
  const withFinding = await addLocalPrComment(repo, pr.id, "typo finding", { role: "reviewer" });
  const finding = withFinding.comments.find((c) => c.body === "typo finding");
  assert.ok(finding);
  const edited = await editLocalPrComment(repo, pr.id, finding.id, "fixed finding");
  assert.equal(edited.comments.find((c) => c.id === finding.id)?.body, "fixed finding");
  await addLocalPrComment(repo, pr.id, "nested reply", {
    role: "agent",
    replyTo: finding.id,
  });
  const cleared = await deleteLocalPrComment(repo, pr.id, finding.id);
  assert.equal(
    cleared.comments.some((c) => c.id === finding.id),
    false,
  );
  assert.equal(
    cleared.comments.some((c) => c.replyTo === finding.id),
    false,
  );
});
test("localPrMatchesSearch matches title body comment and file", async () => {
  git(["checkout", "main"]);
  const pr = await createLocalPr(repo, {
    title: "Alpha search title",
    body: "Body mentions widget-xyz uniquely",
    base: "main",
  });
  assert.ok(pr.worktreePath);
  await addLocalPrComment(repo, pr.id, "Finding about flubber", {
    role: "reviewer",
    path: "src/flubber.ts",
  });
  await writeFile(path.join(pr.worktreePath, "unique-file-token.txt"), "x\n");
  git(["add", "unique-file-token.txt"], pr.worktreePath);
  git(["commit", "-m", "add unique file"], pr.worktreePath);
  const fresh = await getLocalPr(repo, pr.id);

  assert.equal(localPrMatchesSearch(fresh, "Alpha search"), true);
  assert.equal(localPrMatchesSearch(fresh, "widget-xyz"), true);
  assert.equal(localPrMatchesSearch(fresh, "flubber"), true);
  assert.equal(localPrMatchesSearch(fresh, "flubber.ts", { files: [] }), true);
  assert.equal(localPrMatchesSearch(fresh, "nope-missing"), false);
  assert.equal(
    localPrMatchesSearch(fresh, "unique-file-token", {
      files: ["unique-file-token.txt"],
    }),
    true,
  );
  assert.equal(localPrMatchesSearch(fresh, "Alpha search", { fields: ["body"] }), false);

  const byTitle = await listLocalPrs(repo, { search: "Alpha search title" });
  assert.ok(byTitle.some((p) => p.id === pr.id));
  const byFile = await listLocalPrs(repo, { search: "unique-file-token" });
  assert.ok(byFile.some((p) => p.id === pr.id));
  const byComment = await listLocalPrs(repo, { search: "Finding about flubber" });
  assert.ok(byComment.some((p) => p.id === pr.id));
  const none = await listLocalPrs(repo, { search: "zzznomatch999" });
  assert.equal(
    none.some((p) => p.id === pr.id),
    false,
  );
  const titleOnly = await listLocalPrs(repo, {
    search: "widget-xyz",
    in: ["title"],
  });
  assert.equal(
    titleOnly.some((p) => p.id === pr.id),
    false,
  );
});

test("createLocalPr refuses dirty tracked plugin build artifacts on primary", async () => {
  const hookDir = path.join(repo, "packages", "plugin", "hooks");
  const mcpDir = path.join(repo, "packages", "plugin", "mcp");
  await mkdir(hookDir, { recursive: true });
  await mkdir(mcpDir, { recursive: true });
  await writeFile(path.join(hookDir, "github-gate.cjs"), "/* clean */\n");
  await writeFile(path.join(mcpDir, "server.cjs"), "/* clean */\n");
  git(["add", "packages/plugin"]);
  git(["commit", "-m", "track plugin bundles"]);
  await writeFile(path.join(hookDir, "github-gate.cjs"), "/* dirty build */\n");
  await writeFile(path.join(mcpDir, "server.cjs"), "/* dirty build */\n");

  await assert.rejects(
    () => createLocalPr(repo, { title: "Should refuse dirt", base: "main" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /dirty tracked plugin build artifacts/);
      assert.match(err.message, /git stash push|git restore/);
      assert.match(err.message, /packages\/plugin\/hooks\/github-gate\.cjs/);
      return true;
    },
  );

  git(["restore", "--", "packages/plugin"]);
});

test("pruneLoopWorktrees clears leftover .loops between cases", async () => {
  const first = await createLocalPr(repo, { title: "Prune A", base: "main" });
  assert.ok(first.worktreePath);
  const second = await createLocalPr(repo, { title: "Prune B", base: "main" });
  assert.ok(second.worktreePath);
  assert.notEqual(first.worktreePath, second.worktreePath);
  await pruneLoopWorktrees(repo);
  const trees = await listWorktrees(repo);
  assert.equal(trees.filter((t) => loopWorktreeIdentity(t.path)).length, 0);
});

test("RAD-125: updateLocalPr / getLocalPr refresh headSha after commit", async () => {
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/rad-125-update"]);
  await writeFile(path.join(repo, "upd125.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "upd125 one"]);
  const pr = await createLocalPr(repo, { title: "RAD-125 update", base: "main" });
  const oldSha = pr.headSha;

  const tipCwd = pr.worktreePath ?? repo;
  await writeFile(path.join(tipCwd, "upd125.txt"), "2\n");
  git(["add", "."], tipCwd);
  git(["commit", "-m", "upd125 two"], tipCwd);
  const newSha = git(["rev-parse", "HEAD"], tipCwd);
  assert.notEqual(newSha, oldSha);

  const updated = await updateLocalPr(repo, pr.id, { body: "refreshed summary" });
  assert.equal(updated.headSha, newSha);
  assert.equal(updated.body, "refreshed summary");

  const shown = await getLocalPr(repo, pr.id);
  assert.equal(shown.headSha, newSha);
});

test("RAD-126: refreshLocalPrHead invalidates reviewed when tip moves", async () => {
  const { refreshLocalPrHead, setLocalPrExportGate } = await import("./prs.js");
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/rad-126-invalidate"]);
  await writeFile(path.join(repo, "inv126.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "inv126 one"]);
  const pr = await createLocalPr(repo, { title: "RAD-126 invalidate", base: "main" });
  await setLocalPrStatus(repo, pr.id, "reviewed");
  await setLocalPrExportGate(repo, pr.id, {
    status: "ready",
    reasons: [],
    headSha: pr.headSha,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });

  const tipCwd = pr.worktreePath ?? repo;
  await writeFile(path.join(tipCwd, "inv126.txt"), "2\n");
  git(["add", "."], tipCwd);
  git(["commit", "-m", "inv126 two"], tipCwd);
  const newSha = git(["rev-parse", "HEAD"], tipCwd);

  const refreshed = await refreshLocalPrHead(repo, pr.id);
  assert.equal(refreshed.headSha, newSha);
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.exportGate, null);
  assert.equal(refreshed.reviewRequestedSha, newSha);
  assert.equal(refreshed.reviewerNotifiedSha, null);
});

test("RAD-125: refreshLocalPrHead falls through when packet worktreePath is pruned", async () => {
  const { refreshLocalPrHead } = await import("./prs.js");
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/rad-125-stale-wt"]);
  await writeFile(path.join(repo, "stale-wt.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "stale-wt one"]);
  const pr = await createLocalPr(repo, { title: "RAD-125 stale wt", base: "main" });
  assert.ok(pr.worktreePath);
  const tipSha = pr.headSha;
  const stalePath = pr.worktreePath;

  // Remove the exclusive checkout but leave a dead path on the packet (reviewer MEDIUM).
  git(["worktree", "remove", "--force", stalePath]);
  const dir = await prsDir(repo);
  const file = prFile(dir, pr.id);
  const onDisk = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
  onDisk.worktreePath = stalePath;
  await writeJsonFile(file, onDisk);

  const refreshed = await refreshLocalPrHead(repo, pr.id);
  assert.equal(refreshed.headSha, tipSha);
  assert.equal(refreshed.worktreePath, null);
  // Disk path cleared so a later refresh cannot try the pruned directory again.
  const after = parseJsonObject<LocalPr>(await readFile(file, "utf8"));
  assert.equal(after.worktreePath, null);
});
