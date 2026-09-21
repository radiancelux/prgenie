import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { mcpCwdCandidates, resolveMcpGitRoot } from "./mcp-cwd.js";

let repo = "";
let outside = "";
const envSnapshot = {
  CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR,
  WORKSPACE_FOLDER_PATHS: process.env.WORKSPACE_FOLDER_PATHS,
  CURSOR_PLUGIN_ROOT: process.env.CURSOR_PLUGIN_ROOT,
};

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-mcp-cwd-"));
  outside = await mkdtemp(path.join(tmpdir(), "prgenie-mcp-outside-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repo });
  repo = git(["rev-parse", "--show-toplevel"]);
});

after(async () => {
  process.chdir(tmpdir());
  if (repo) await rm(repo, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("mcpCwdCandidates prefers CURSOR_PROJECT_DIR then WORKSPACE_FOLDER_PATHS then cwd", () => {
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.WORKSPACE_FOLDER_PATHS;
  const base = mcpCwdCandidates();
  assert.ok(base.includes(process.cwd()));

  process.env.CURSOR_PROJECT_DIR = "C:/ws/project";
  process.env.WORKSPACE_FOLDER_PATHS = `C:/ws/alt${path.delimiter}C:/ws/project`;
  const withEnv = mcpCwdCandidates();
  assert.equal(withEnv[0], path.normalize("C:/ws/project"));
  assert.ok(withEnv.includes(path.normalize("C:/ws/alt")));
});

test("resolveMcpGitRoot uses workspace env when process.cwd is outside repo", async () => {
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.WORKSPACE_FOLDER_PATHS;
  delete process.env.CURSOR_PLUGIN_ROOT;
  process.env.CURSOR_PROJECT_DIR = repo;
  process.chdir(outside);

  const root = await resolveMcpGitRoot();
  assert.equal(path.normalize(root), path.normalize(repo));
});

test("resolveMcpGitRoot error names expected workspace root", async () => {
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.WORKSPACE_FOLDER_PATHS;
  process.env.CURSOR_PROJECT_DIR = outside;
  process.env.CURSOR_PLUGIN_ROOT = outside;
  process.chdir(outside);

  await assert.rejects(
    () => resolveMcpGitRoot(),
    (err: Error) => {
      assert.match(
        err.message,
        new RegExp(`Expected workspace git root at ${outside.replace(/\\/g, "[\\\\/]")}`),
      );
      assert.match(err.message, /plugin install/);
      assert.match(err.message, /Tried:/);
      return true;
    },
  );
});

test("resolveMcpGitRoot honors explicit cwd", async () => {
  const root = await resolveMcpGitRoot(repo);
  assert.equal(path.normalize(root), path.normalize(repo));
});
