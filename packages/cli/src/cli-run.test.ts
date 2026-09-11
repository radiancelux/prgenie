import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/prgenie.cjs");

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function prgenie(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliJs, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-cli-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feat/cli-parse"]);
  await writeFile(path.join(repo, "a.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "change"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("cli --help prints usage and exits 0", () => {
  const result = prgenie(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie create/);
});

test("cli -h prints usage and exits 0", () => {
  const result = prgenie(["-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie create/);
});

test("cli version prints version and exits 0", () => {
  const result = prgenie(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("cli attach --help prints attach usage and exits 0", () => {
  const result = prgenie(["attach", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie attach/);
  assert.match(result.stdout, /Attach an existing GitHub PR/);
});

test("cli attach -h prints attach usage and exits 0", () => {
  const result = prgenie(["attach", "-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie attach/);
});

test("cli create --help prints create usage and exits 0", () => {
  const result = prgenie(["create", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie create/);
});

test("cli list --help prints list usage and exits 0", () => {
  const result = prgenie(["list", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie list/);
});

test("cli show --help prints show usage and exits 0", () => {
  const result = prgenie(["show", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie show/);
});

test("cli list rejects invalid --in fields", () => {
  const result = prgenie(["list", "--in", "title,bogus"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--in fields must be/);
});

test("cli watch listen rejects unknown role", () => {
  const result = prgenie(["watch", "listen", "neither"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /watch listen inbox\|queue/);
});

test("cli watch listen rejects bad --interval", () => {
  const result = prgenie(["watch", "listen", "inbox", "--interval", "0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--interval must be/);
});

test("cli create + ready + list --search round-trip", () => {
  const created = prgenie([
    "create",
    "--title",
    "CLI parse loop",
    "--body",
    "Exercise create/list/ready parsing.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  const ready = prgenie(["ready", id]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stdout, new RegExp(`${id}\\s+ready`));
  const listed = prgenie(["list", "--search", "CLI parse", "--in", "title"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(id));
});

test("cli delete requires --yes", () => {
  const result = prgenie(["delete", "lp-deadbeef"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /delete <id> --yes/);
});

test("cli comment requires -m", () => {
  const result = prgenie(["comment", "lp-deadbeef"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /comment <id> -m/);
});

test("cli learnings with no args lists repo learnings", () => {
  const result = prgenie(["learnings"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No learnings/);
});

test("cli learnings --disabled works", () => {
  const result = prgenie(["learnings", "--disabled"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No learnings/);
});

test("cli learnings --category works", () => {
  const result = prgenie(["learnings", "--category", "testing"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No learnings/);
});
