import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  formatWatchLane,
  getRepoWatch,
  haltWatch,
  haltWatchRole,
  LISTEN_REMOVED_MESSAGE,
  resumeWatch,
  resumeWatchRole,
} from "./watch.js";
import { consoleDir, writeJsonFile } from "./store.js";

let repo = "";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-watch-"));
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

test("export halt is visible on both lanes; idle lanes format as idle", async () => {
  const idle = await getRepoWatch(repo);
  assert.equal(idle.halted, false);
  assert.equal(formatWatchLane(idle, "inbox"), "idle");
  assert.match(LISTEN_REMOVED_MESSAGE, /Use \/steward/);

  const shipped = await haltWatch(repo, "export", "lp-deadbeef");
  assert.equal(shipped.halted, true);
  assert.equal(shipped.reason, "export");
  assert.equal(shipped.exportId, "lp-deadbeef");
  assert.equal((await getRepoWatch(repo)).halted, true);

  const resumed = await resumeWatch(repo);
  assert.equal(resumed.halted, false);
  assert.equal((await getRepoWatch(repo)).reason, null);
  assert.equal(resumed.inbox.halted, false);
  assert.equal(resumed.queue.halted, false);
});

test("legacy watch.json halt applies to both lanes", async () => {
  await writeJsonFile(path.join(await consoleDir(repo), "watch.json"), {
    halted: true,
    reason: "export",
    exportId: "lp-old",
    updatedAt: new Date().toISOString(),
  });
  const state = await getRepoWatch(repo);
  assert.equal(state.inbox.halted, true);
  assert.equal(state.queue.halted, true);
  assert.equal(state.halted, true);
  await resumeWatch(repo);
});

test("per-lane halt/resume still isolate inbox from queue", async () => {
  await haltWatchRole(repo, "inbox", "stop");
  const state = await getRepoWatch(repo);
  assert.equal(state.halted, false);
  assert.equal(state.inbox.halted, true);
  assert.equal(state.queue.halted, false);

  await haltWatchRole(repo, "queue", "stop");
  const both = await getRepoWatch(repo);
  assert.equal(both.halted, true);

  await resumeWatchRole(repo, "inbox");
  const mixed = await getRepoWatch(repo);
  assert.equal(mixed.inbox.halted, false);
  assert.equal(mixed.queue.halted, true);
  await resumeWatch(repo);
});

test("parallel lane mutations do not lose a lane", async () => {
  await resumeWatch(repo);
  await Promise.all([haltWatchRole(repo, "inbox", "stop"), haltWatchRole(repo, "queue", "stop")]);
  const both = await getRepoWatch(repo);
  assert.equal(both.inbox.halted, true);
  assert.equal(both.queue.halted, true);
  await resumeWatch(repo);
});
