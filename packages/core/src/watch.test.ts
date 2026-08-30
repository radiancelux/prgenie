import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createLocalPr, markReviewerNotified, setLocalPrStatus } from "./prs.js";
import { getRepoWatch, haltWatch, haltWatchRole, resumeWatch, resumeWatchRole } from "./watch.js";
import { listenActivityFingerprint } from "./watchActivity.js";
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
    ticks: 10,
    idleMs: 60_000,
    maxMs: 60_000,
    intervalMs: 5,
    activityFingerprint: async () => "stable",
    write: (line) => lines.push(line),
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) await haltWatchRole(repo, "inbox", "stop");
    },
  });
  const result = await done;
  assert.equal(result, "halted");
  assert.ok(lines.some((l) => l.startsWith("AGENT_LOOP_TICK_review-inbox")));
  assert.ok(lines.some((l) => l.includes('"reason":"stop"')));
  await resumeWatch(repo);
});

test("listenWatchLane ends on idle when activity is quiet", async () => {
  const { listenWatchLane, parseDurationMs } = await import("./watch.js");
  assert.equal(parseDurationMs("30m"), 30 * 60_000);
  assert.equal(parseDurationMs("8h"), 8 * 60 * 60_000);
  assert.equal(parseDurationMs("45"), 45 * 60_000);
  await resumeWatch(repo);
  const lines: string[] = [];
  let clock = 0;
  const result = await listenWatchLane(repo, "inbox", {
    idleMs: 100,
    maxMs: 10_000,
    intervalMs: 50,
    now: () => clock,
    activityFingerprint: async () => "quiet",
    write: (line) => lines.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result, "done");
  assert.ok(lines.some((l) => l.includes('"reason":"idle"')));
  await resumeWatch(repo);
});

test("listenWatchLane idle resets when activity fingerprint changes", async () => {
  const { listenWatchLane } = await import("./watch.js");
  await resumeWatch(repo);
  const lines: string[] = [];
  let clock = 0;
  let finger = "a";
  const result = await listenWatchLane(repo, "queue", {
    idleMs: 100,
    maxMs: 10_000,
    intervalMs: 50,
    now: () => clock,
    activityFingerprint: async () => finger,
    write: (line) => lines.push(line),
    sleep: async (ms) => {
      clock += ms;
      // Quiet fingerprint would DONE at clock=100. Flip past each deadline so
      // idle must reset or this assertion fails.
      if (clock === 100 || clock === 200) finger = `moved-${clock}`;
    },
  });
  assert.equal(result, "done");
  assert.ok(lines.some((l) => l.includes('"reason":"idle"')));
  assert.ok(clock >= 300, `idle reset should reach clock>=300, got ${clock}`);
  const ticks = lines.filter((l) => l.startsWith("AGENT_LOOP_TICK_review-queue"));
  assert.ok(ticks.length >= 4, `expected more ticks than quiet baseline (~2), got ${ticks.length}`);
  await resumeWatch(repo);
});

test("listenWatchLane ends on max ceiling", async () => {
  const { listenWatchLane } = await import("./watch.js");
  await resumeWatch(repo);
  const lines: string[] = [];
  let clock = 0;
  let n = 0;
  const result = await listenWatchLane(repo, "inbox", {
    idleMs: 10_000,
    maxMs: 120,
    intervalMs: 50,
    now: () => clock,
    activityFingerprint: async () => `move-${n++}`,
    write: (line) => lines.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result, "done");
  assert.ok(lines.some((l) => l.includes('"reason":"max"')));
  await resumeWatch(repo);
});

test("listenActivityFingerprint inbox none vs current worktree loop", async () => {
  const empty = await listenActivityFingerprint(repo, "inbox");
  assert.match(empty, /^inbox:none:/);

  git(["checkout", "-b", "feat/listen-fp"]);
  await writeFile(path.join(repo, "fp.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "fp"]);
  const pr = await createLocalPr(repo, { title: "Fingerprint", base: "main" });
  const withLoop = await listenActivityFingerprint(repo, "inbox");
  assert.match(withLoop, new RegExp(`^inbox:${pr.id}:`));
  assert.notEqual(withLoop, empty);

  const again = await listenActivityFingerprint(repo, "inbox");
  assert.equal(again, withLoop);

  await setLocalPrStatus(repo, pr.id, "ready");
  const afterReady = await listenActivityFingerprint(repo, "inbox");
  assert.notEqual(afterReady, withLoop);
  assert.match(afterReady, new RegExp(`^inbox:${pr.id}:ready:`));
});

test("listenActivityFingerprint queue tracks ready and live changes", async () => {
  git(["checkout", "main"]);
  git(["checkout", "-b", "feat/queue-fp"]);
  await writeFile(path.join(repo, "q.txt"), "q\n");
  git(["add", "."]);
  git(["commit", "-m", "queue fp"]);
  const pr = await createLocalPr(repo, { title: "Queue fp", base: "main" });
  const draftFp = await listenActivityFingerprint(repo, "queue");
  assert.match(draftFp, /^queue:/);
  assert.match(draftFp, new RegExp(`${pr.id}:draft:`));
  assert.doesNotMatch(draftFp, new RegExp(`ready=${pr.id}:`));

  await setLocalPrStatus(repo, pr.id, "ready");
  const readyFp = await listenActivityFingerprint(repo, "queue");
  assert.notEqual(readyFp, draftFp);
  assert.match(readyFp, new RegExp(`(^|\\|)${pr.id}:`));
  assert.ok(readyFp.includes("ready=") && readyFp.indexOf(pr.id) < readyFp.indexOf(";live="));

  const notified = await markReviewerNotified(repo, pr.id);
  const notifiedFp = await listenActivityFingerprint(repo, "queue");
  assert.notEqual(notifiedFp, readyFp);
  assert.ok(notifiedFp.includes(notified.reviewerNotifiedSha ?? "missing"));
});
