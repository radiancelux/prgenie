import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appendSession, listSessions } from "./sessions.js";
import { sessionsFile } from "./store.js";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-sessions-"));
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

test("listSessions returns empty when file missing", async () => {
  const events = await listSessions(repo);
  assert.deepEqual(events, []);
});

test("appendSession and listSessions happy path with limit and hook", async () => {
  await appendSession(repo, { hook: "subagentStop", status: "completed", task: "one" });
  await appendSession(repo, { hook: "other", status: "completed", task: "two" });
  await appendSession(repo, { hook: "subagentStop", status: "aborted", task: "three" });

  const all = await listSessions(repo, { limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0].task, "three");
  assert.equal(all[2].task, "one");
  assert.ok(typeof all[0].at === "string");
  assert.ok(typeof all[0].gitRoot === "string");

  const limited = await listSessions(repo, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].task, "three");
  assert.equal(limited[1].task, "two");

  const hooked = await listSessions(repo, { hook: "subagentStop", limit: 10 });
  assert.equal(hooked.length, 2);
  assert.ok(hooked.every((e) => e.hook === "subagentStop"));
});

test("listSessions skips corrupt and non-object lines", async () => {
  const file = await sessionsFile(repo);
  const existing = await readFile(file, "utf8");
  await writeFile(
    file,
    [
      existing.trimEnd(),
      "not-json",
      "[1,2,3]",
      '"string"',
      "{",
      JSON.stringify({
        hook: "subagentStop",
        status: "ok",
        task: "good",
        at: "2099-01-01T00:00:00.000Z",
      }),
      "",
    ].join("\n") + "\n",
    "utf8",
  );

  const events = await listSessions(repo, { limit: 100 });
  assert.ok(events.every((e) => e && typeof e === "object" && !Array.isArray(e)));
  assert.ok(events.some((e) => e.task === "good"));
  assert.equal(events.filter((e) => e.task === "good").length, 1);
});
