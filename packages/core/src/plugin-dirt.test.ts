import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  assertNoDirtyPluginBuildArtifacts,
  formatDirtyPluginBuildArtifactsError,
  isPluginBuildArtifact,
  listDirtyPluginBuildArtifacts,
} from "./plugin-dirt.js";
import { createLocalPr } from "./prs.js";
import { pruneLoopWorktrees } from "./worktrees.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";

let dir = "";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "prgenie-plugin-dirt-"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("isPluginBuildArtifact matches hooks/mcp .cjs only", () => {
  assert.equal(isPluginBuildArtifact("packages/plugin/hooks/x.cjs"), true);
  assert.equal(isPluginBuildArtifact("packages/plugin/mcp/server.cjs"), true);
  assert.equal(isPluginBuildArtifact("packages/plugin/skills/start/SKILL.md"), false);
  assert.equal(isPluginBuildArtifact("packages/core/src/git.ts"), false);
});

test("formatDirtyPluginBuildArtifactsError names stash/restore and Switch", () => {
  const msg = formatDirtyPluginBuildArtifactsError(["packages/plugin/hooks/a.cjs"]);
  assert.match(msg, /dirty tracked plugin build artifacts/);
  assert.match(msg, /stash|restore/i);
  assert.match(msg, /Switch/);
  assert.match(msg, /\.loops/);
});

test("listDirtyPluginBuildArtifacts ignores untracked and non-artifact paths", async () => {
  const repo = path.join(dir, "list-dirt");
  await mkdir(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@prgenie.ai"], repo);
  git(["config", "user.name", "PR Genie Test"], repo);
  await mkdir(path.join(repo, "packages", "plugin", "hooks"), { recursive: true });
  await mkdir(path.join(repo, "packages", "plugin", "mcp"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await writeFile(path.join(repo, "packages", "plugin", "hooks", "x.cjs"), "/* built */\n");
  await writeFile(path.join(repo, "packages", "plugin", "mcp", "server.cjs"), "/* mcp */\n");
  await writeFile(path.join(repo, "packages", "plugin", "skills.md"), "skill\n");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);

  await writeFile(path.join(repo, "packages", "plugin", "hooks", "x.cjs"), "/* dirty */\n");
  await writeFile(path.join(repo, "packages", "plugin", "skills.md"), "changed\n");
  await writeFile(path.join(repo, "packages", "plugin", "hooks", "scratch.cjs"), "/* untracked */\n");

  const dirty = await listDirtyPluginBuildArtifacts(repo);
  assert.deepEqual(dirty, ["packages/plugin/hooks/x.cjs"]);
});

test("createLocalPr refuses dirty tracked plugin .cjs on primary", async () => {
  const repo = path.join(dir, "refuse-create");
  await mkdir(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@prgenie.ai"], repo);
  git(["config", "user.name", "PR Genie Test"], repo);
  await mkdir(path.join(repo, "packages", "plugin", "hooks"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await writeFile(path.join(repo, "packages", "plugin", "hooks", "x.cjs"), "/* built */\n");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);
  await writeFile(path.join(repo, "packages", "plugin", "hooks", "x.cjs"), "/* dirty */\n");

  await assert.rejects(
    () => assertNoDirtyPluginBuildArtifacts(repo),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /dirty tracked plugin build artifacts/);
      return true;
    },
  );

  await assert.rejects(
    () => createLocalPr(repo, { title: "should fail", body: "test" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /dirty tracked plugin build artifacts/);
      return true;
    },
  );

  await pruneLoopWorktrees(repo);
});

test("doctor plugin-dirt fails when primary has dirty tracked plugin .cjs", async () => {
  const repo = path.join(dir, "doctor-dirt");
  await mkdir(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@prgenie.ai"], repo);
  git(["config", "user.name", "PR Genie Test"], repo);
  await mkdir(path.join(repo, "packages", "plugin", "mcp"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await writeFile(path.join(repo, "packages", "plugin", "mcp", "server.cjs"), "/* mcp */\n");
  git(["add", "."], repo);
  git(["commit", "-m", "initial"], repo);
  await writeFile(path.join(repo, "packages", "plugin", "mcp", "server.cjs"), "/* dirty */\n");

  const home = path.join(dir, "home-doctor-dirt");
  const report = await runDoctor(repo, { home });
  const check = report.checks.find((c) => c.id === "plugin-dirt");
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.match(check.summary, /mcp\/server\.cjs/);
  assert.match(check.fix ?? "", /stash|restore|Switch/i);
  assert.match(formatDoctorReport(report), /plugin-dirt/);
});
