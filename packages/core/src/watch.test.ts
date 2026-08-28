import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { getRepoWatch, haltWatch, resumeWatch } from "./watch.js";

let repo = "";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-watch-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("watch halt is visible to both listen loops", async () => {
  const idle = await getRepoWatch(repo);
  assert.equal(idle.halted, false);

  const stopped = await haltWatch(repo, "stop");
  assert.equal(stopped.halted, true);
  assert.equal(stopped.reason, "stop");
  assert.equal((await getRepoWatch(repo)).halted, true);

  const shipped = await haltWatch(repo, "export", "lp-deadbeef");
  assert.equal(shipped.reason, "export");
  assert.equal(shipped.exportId, "lp-deadbeef");

  const resumed = await resumeWatch(repo);
  assert.equal(resumed.halted, false);
  assert.equal((await getRepoWatch(repo)).reason, null);
});
