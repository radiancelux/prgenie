import assert from "node:assert/strict";
import { test } from "node:test";
import { isGithubCli, isPublish, switchUser } from "./github-hook.js";

test("isPublish flags git push and gh pr create/merge/repo create", () => {
  assert.equal(isPublish("git push origin HEAD"), true);
  assert.equal(isPublish("git.exe push -u origin main"), true);
  assert.equal(isPublish("gh pr create --title t"), true);
  assert.equal(isPublish("gh.exe pr merge 12"), true);
  assert.equal(isPublish("gh repo create foo"), true);
  assert.equal(isPublish("git status"), false);
  assert.equal(isPublish("gh pr view 1"), false);
  assert.equal(isPublish("pnpm test"), false);
});

test("isGithubCli matches gh and git push", () => {
  assert.equal(isGithubCli("gh auth status"), true);
  assert.equal(isGithubCli("gh.exe pr list"), true);
  assert.equal(isGithubCli("git push origin HEAD"), true);
  assert.equal(isGithubCli("git commit -m x"), false);
});

test("switchUser extracts --user from gh auth switch", () => {
  assert.equal(switchUser("gh auth switch --user alice"), "alice");
  assert.equal(switchUser("gh.exe auth switch --hostname github.com --user Bob"), "Bob");
  assert.equal(switchUser("gh auth status"), null);
  assert.equal(switchUser("git push"), null);
});
