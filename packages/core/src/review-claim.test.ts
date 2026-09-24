import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  claimReview,
  formatClaimReview,
  getReviewClaim,
  listReviewClaims,
} from "./review-claim.js";
import { completeLocalPrReview, createLocalPr, setLocalPrStatus } from "./prs.js";

let repo = "";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-claim-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feat/claim"]);
  await writeFile(path.join(repo, "a.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "work"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("claimReview is exclusive for the same id+headSha", async () => {
  const pr = await createLocalPr(repo, { title: "Claim exclusive", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });

  const first = await claimReview(repo, pr.id, { source: "queue" });
  assert.equal(first.claimed, true);
  assert.equal(first.claim?.id, pr.id);
  assert.equal(first.claim?.headSha, pr.headSha);
  assert.equal(first.claim?.source, "queue");
  assert.match(formatClaimReview(first), /^claimed {2}/);

  const second = await claimReview(repo, pr.id, { source: "hook" });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "already_claimed");
  assert.equal(second.claim?.headSha, pr.headSha);
  assert.match(formatClaimReview(second), /^already_claimed {2}/);

  const listed = await listReviewClaims(repo);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, pr.id);
  assert.equal((await getReviewClaim(repo, pr.id, pr.headSha)) !== null, true);
});

test("claimReview serializes concurrent attempts to one winner", async () => {
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/claim-race"]);
  await writeFile(path.join(repo, "race.txt"), "r\n");
  git(["add", "."]);
  git(["commit", "-m", "race"]);
  const pr = await createLocalPr(repo, { title: "Claim race", base: "main" });
  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });

  const results = await Promise.all([
    claimReview(repo, pr.id, { source: "queue" }),
    claimReview(repo, pr.id, { source: "hook" }),
    claimReview(repo, pr.id, { source: "cli" }),
  ]);
  const won = results.filter((r) => r.claimed);
  const lost = results.filter((r) => !r.claimed);
  assert.equal(won.length, 1);
  assert.equal(lost.length, 2);
  assert.ok(lost.every((r) => r.reason === "already_claimed"));
  assert.equal((await listReviewClaims(repo)).filter((c) => c.id === pr.id).length, 1);
});

test("claimReview refuses draft and allows a new HEAD after complete", async () => {
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/claim-stale"]);
  await writeFile(path.join(repo, "stale.txt"), "s\n");
  git(["add", "."]);
  git(["commit", "-m", "stale"]);
  const pr = await createLocalPr(repo, { title: "Claim stale", base: "main" });

  const draft = await claimReview(repo, pr.id);
  assert.equal(draft.claimed, false);
  assert.equal(draft.reason, "not_ready");
  assert.match(formatClaimReview(draft), /^not_ready {2}/);

  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const ready = await claimReview(repo, pr.id, { source: "queue" });
  assert.equal(ready.claimed, true);

  const mismatch = await claimReview(repo, pr.id, { headSha: "0".repeat(40) });
  assert.equal(mismatch.claimed, false);
  assert.equal(mismatch.reason, "head_mismatch");

  await completeLocalPrReview(repo, pr.id, { body: "LGTM", allowDrift: true });
  const afterComplete = await listReviewClaims(repo);
  assert.equal(
    afterComplete.some((c) => c.id === pr.id),
    false,
  );

  await setLocalPrStatus(repo, pr.id, "ready", { ciSkipReason: "test" });
  const again = await claimReview(repo, pr.id, { source: "queue" });
  assert.equal(again.claimed, true);
  assert.equal(again.claim?.headSha, pr.headSha);
});
