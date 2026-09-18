import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  bindSteward,
  createLocalPr,
  getLocalPr,
  getReviewClaim,
  getStewardBinding,
  listReviewClaims,
  setLocalPrStatus,
  shouldEmitLegacyReviewerHandoff,
} from "@prgenie/core";
import { eventName, inferCwd, runStopReviewerHandoff } from "./review-hook.js";

test("inferCwd prefers cwd then workspace_roots then process.cwd", () => {
  assert.equal(inferCwd({ cwd: "C:/repo" }), "C:/repo");
  assert.equal(inferCwd({ workspace_roots: ["C:/ws"] }), "C:/ws");
  assert.equal(inferCwd({ cwd: "", workspace_roots: ["C:/ws"] }), "C:/ws");
  assert.equal(inferCwd({}), process.cwd());
});

test("eventName reads hook_event_name or event", () => {
  assert.equal(eventName({ hook_event_name: "stop" }), "stop");
  assert.equal(eventName({ event: "sessionStart" }), "sessionStart");
  assert.equal(eventName({}), "");
});

let repo = "";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-review-hook-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("legacy stop hook stays silent on steward-owned loops and still claims non-stewarded ones", async () => {
  git(["checkout", "-b", "feat/steward-owned"]);
  await writeFile(path.join(repo, "owned.txt"), "o\n");
  git(["add", "."]);
  git(["commit", "-m", "owned"]);
  const owned = await createLocalPr(repo, { title: "Steward owned", base: "main" });
  await bindSteward(repo, owned.id, { implementorTaskId: "task-impl-owned" });
  await setLocalPrStatus(repo, owned.id, "ready");
  const ownedPr = await getLocalPr(repo, owned.id);
  assert.equal(
    shouldEmitLegacyReviewerHandoff(ownedPr, await getStewardBinding(repo, owned.id)),
    false,
  );

  const ownedFollowup = await runStopReviewerHandoff(repo, owned.id);
  assert.equal(ownedFollowup, null);
  assert.equal(await getReviewClaim(repo, owned.id, ownedPr.headSha), null);
  assert.equal(
    (await listReviewClaims(repo)).some((c) => c.id === owned.id),
    false,
  );

  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/no-steward"]);
  await writeFile(path.join(repo, "free.txt"), "f\n");
  git(["add", "."]);
  git(["commit", "-m", "free"]);
  const free = await createLocalPr(repo, { title: "No steward", base: "main" });
  await setLocalPrStatus(repo, free.id, "ready");
  const freePr = await getLocalPr(repo, free.id);
  assert.equal(shouldEmitLegacyReviewerHandoff(freePr, null), true);

  const freeFollowup = await runStopReviewerHandoff(repo, free.id);
  assert.ok(freeFollowup);
  assert.match(freeFollowup, /claim_review/);
  assert.match(freeFollowup, new RegExp(free.id));
  const claim = await getReviewClaim(repo, free.id, freePr.headSha);
  assert.ok(claim);
  assert.equal(claim.source, "hook");
});
