import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { getRepoWatch, haltWatch, haltWatchRole, resumeWatch, resumeWatchRole } from "./watch.js";
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
  assert.equal(resumed.inbox.halted, false);
  assert.equal(resumed.queue.halted, false);
});

test("stop-loop does not halt the reviewer queue", async () => {
  await haltWatchRole(repo, "inbox", "stop");
  const state = await getRepoWatch(repo);
  assert.equal(state.halted, false);
  assert.equal(state.inbox.halted, true);
  assert.equal(state.inbox.reason, "stop");
  assert.equal(state.queue.halted, false);

  await haltWatchRole(repo, "queue", "stop");
  const both = await getRepoWatch(repo);
  assert.equal(both.halted, true);
  assert.equal(both.queue.halted, true);
});

test("legacy watch.json halt applies to both lanes", async () => {
  await writeJsonFile(path.join(await consoleDir(repo), "watch.json"), {
    halted: true,
    reason: "stop",
    exportId: null,
    updatedAt: new Date().toISOString(),
  });
  const state = await getRepoWatch(repo);
  assert.equal(state.inbox.halted, true);
  assert.equal(state.queue.halted, true);
  assert.equal(state.halted, true);
});

test("start inbox does not resume the reviewer queue", async () => {
  await haltWatch(repo, "stop");
  const state = await resumeWatchRole(repo, "inbox");
  assert.equal(state.inbox.halted, false);
  assert.equal(state.queue.halted, true);
  await resumeWatch(repo);
});

test("parallel lane mutations do not lose a lane", async () => {
  await resumeWatch(repo);
  await Promise.all([
    haltWatchRole(repo, "inbox", "stop"),
    haltWatchRole(repo, "queue", "stop"),
  ]);
  const both = await getRepoWatch(repo);
  assert.equal(both.inbox.halted, true);
  assert.equal(both.queue.halted, true);

  await Promise.all([resumeWatchRole(repo, "inbox"), haltWatchRole(repo, "queue", "stop")]);
  const mixed = await getRepoWatch(repo);
  assert.equal(mixed.inbox.halted, false);
  assert.equal(mixed.queue.halted, true);
  await resumeWatch(repo);
});

test("listenWatchLane prints ticks and stops on halt", async () => {
  const { listenWatchLane } = await import("./watch.js");
  await resumeWatch(repo);
  const lines: string[] = [];
  let sleeps = 0;
  const done = listenWatchLane(repo, "inbox", {
    ticks: 3,
    intervalMs: 5,
    write: (line) => lines.push(line),
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) await haltWatchRole(repo, "inbox", "stop");
    },
  });
  const result = await done;
  assert.equal(result, "halted");
  assert.ok(lines.some((l) => l.startsWith("AGENT_LOOP_TICK_review-inbox")));
  assert.ok(lines.some((l) => l.startsWith("AGENT_LOOP_DONE_review-inbox")));
  await resumeWatch(repo);
});
