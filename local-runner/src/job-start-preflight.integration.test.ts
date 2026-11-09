import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { worktreePathExists } from "./worktree-cleanup.js";
import { ValidationError } from "./validation-error.js";
import { runInit } from "./init.js";
import { loadSettings, saveSettings } from "./settings.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await execFileAsync("git", ["-C", cwd, ...args]);
  void r;
}

async function initCheckoutRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["commit", "--allow-empty", "-m", "init"]);
}

function testConfig(dataDir: string, dryRun = false): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun,
    defaultCodeRepoPath: null,
  };
}

describe("job preflight integration", () => {
  let dataDir = "";
  let repo = "";
  let bare = "";

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-pf-int-"));
    await runInit({ dataDir });
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-pf-git-"));
    bare = path.join(root, "origin.git");
    repo = path.join(root, "clone");
    await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
    await initCheckoutRepo(repo);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "-u", "origin", "main"]);
    await writeFile(path.join(repo, "README.md"), "# demo\n", "utf8");
    const settings = await loadSettings(dataDir);
    await saveSettings(dataDir, { ...settings, configured: true });
  });

  after(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("rejects real jobs when git author identity is unset (#201)", async () => {
    await git(repo, ["config", "--unset", "user.email"]);
    await git(repo, ["config", "--unset", "user.name"]);
    const emptyGlobal = path.join(dataDir, ".empty-global-gitconfig");
    await writeFile(emptyGlobal, "", "utf8");
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const engine = new RunnerEngine(testConfig(dataDir), { watchCi: false });
    try {
      await assert.rejects(
        () =>
          engine.startJob({
            branch: "chore/no-git-id",
            promptFile: path.join(repo, "README.md"),
            repoPath: repo,
            dryRun: false,
            maxRounds: 1,
          }),
        (err: Error) =>
          err instanceof ValidationError &&
          /user\.(name|email)/.test(err.message) &&
          /git -C/.test(err.message),
      );
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "test"]);
    }
  });

  it("rejects real jobs before creating a worktree when the driver binary is missing", async () => {
    const engine = new RunnerEngine(testConfig(dataDir), { watchCi: false });
    const prev = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    process.env.PRGENIE_RUNNER_INLINE_JOBS = "1";
    try {
      await assert.rejects(
        () =>
          engine.startJob({
            branch: "chore/no-agent",
            promptFile: path.join(repo, "README.md"),
            repoPath: repo,
            dryRun: false,
            maxRounds: 1,
          }),
        (err: Error) => err instanceof ValidationError && /not found on PATH/.test(err.message),
      );
      await assert.rejects(
        () =>
          engine.startJob({
            branch: "chore/no-agent",
            promptFile: path.join(repo, "README.md"),
            repoPath: repo,
            dryRun: false,
            maxRounds: 1,
          }),
        ValidationError,
      );
    } finally {
      process.env.PATH = prev;
      delete process.env.PRGENIE_RUNNER_INLINE_JOBS;
    }
  });

  it("rejects dry runs when repoPath does not exist", async () => {
    const engine = new RunnerEngine(testConfig(dataDir, true), { watchCi: false });
    await assert.rejects(
      () =>
        engine.startJob({
          branch: "chore/bad-path",
          promptFile: "/tmp/p.md",
          repoPath: "/nonexistent/repo",
          dryRun: true,
        }),
      (err: Error) => err instanceof ValidationError && /does not exist/.test(err.message),
    );
  });

  it("records dry-run preflight warnings and finishes without a github PR URL", async () => {
    const noOrigin = await mkdtemp(path.join(os.tmpdir(), "lr-no-origin-"));
    await initCheckoutRepo(noOrigin);
    const prompt = path.join(noOrigin, "README.md");
    await writeFile(prompt, "# x\n", "utf8");
    const engine = new RunnerEngine(testConfig(dataDir, true), { watchCi: false });
    process.env.PRGENIE_RUNNER_INLINE_JOBS = "1";
    try {
      const job = await engine.startJob({
        branch: "chore/dry-warn",
        promptFile: prompt,
        repoPath: noOrigin,
        dryRun: true,
        maxRounds: 1,
      });
      assert.ok(job.preflightWarnings?.length);
      await new Promise((r) => setTimeout(r, 2500));
      const { loadJob } = await import("./store.js");
      const done = await loadJob(dataDir, job.id);
      assert.ok(done);
      assert.equal(done?.dryRun, true);
      assert.equal(done?.prUrl, null);
      assert.ok(done?.stage === "approved" || done?.stage === "building");
    } finally {
      delete process.env.PRGENIE_RUNNER_INLINE_JOBS;
      await rm(noOrigin, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("pristine failed worktree cleanup", () => {
  it("removes a clean unpushed worktree after a failed start", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-pf-wt-"));
    await runInit({ dataDir });
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-pf-wt-git-"));
    const bare = path.join(root, "o.git");
    const repo = path.join(root, "r");
    await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
    await initCheckoutRepo(repo);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "-u", "origin", "main"]);

    const wt = path.join(root, "wt");
    await git(repo, ["worktree", "add", "-B", "chore/fail", wt, "main"]);

    const { tryRemoveJobWorktree } = await import("./worktree-cleanup.js");
    const { saveJob } = await import("./store.js");
    const config = testConfig(dataDir);
    const job = {
      id: "job-fail-wt",
      createdAt: "",
      updatedAt: "",
      input: { repoPath: repo, branch: "chore/fail", promptFile: "/p" },
      stage: "failed" as const,
      reviewRound: 0,
      maxRounds: 1,
      model: "m",
      driverId: "cursor-agent",
      worktreePath: wt,
      repoSlug: "demo",
      prUrl: null,
      prNumber: null,
      prIsDraft: null,
      approveHeadSha: null,
      readyPromotedAt: null,
      linearIssue: null,
      ticketUrl: null,
      title: "t",
      tokenUsage: null,
      ciStatus: null,
      lastVerdict: null,
      error: "implementor missing",
      logPath: path.join(dataDir, "logs", "x.log"),
      steerQueue: [],
      stopRequested: false,
      dryRun: false,
      archivedAt: null,
    };
    await saveJob(dataDir, job);
    const gitImpl = async (cwd: string, args: string[]) => {
      const { git } = await import("./github.js");
      return git(cwd, args);
    };
    const res = await tryRemoveJobWorktree(config, job, {
      reason: "terminal_branch_gone",
      gitImpl: gitImpl as never,
      worktreesRoot: root,
      silent: true,
    });
    assert.equal(res.removed, true);
    assert.equal(await worktreePathExists(wt), false);
    await access(wt).then(
      () => assert.fail("worktree dir should be gone"),
      () => undefined,
    );
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
});
