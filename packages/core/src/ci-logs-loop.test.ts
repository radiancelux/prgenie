import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { join } from "node:path";
import { runCiChecks, runLoopCi } from "./ci-runner.js";
import { createLocalPr, setLocalPrStatus } from "./prs.js";
import { git } from "./git.js";
import { gitCommonDir } from "./git.js";
import { createTempGitRepo } from "./test-git-fixture.js";
import { shepherdStatus } from "./shepherd.js";

describe("RAD-136 per-loop CI logs", () => {
  async function initRepo(): Promise<string> {
    return createTempGitRepo({ prefix: "prgenie-ci-logs-", template: "loop-ci" });
  }

  it("RAD-136: runLoopCi and shepherdStatus write logs under the resolved loop id", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            build: "exit 0",
            test: 'node -e "console.error(\\"MARKER-LOOP\\"); process.exit(1)"',
          },
        }),
      );
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "fail test"]);
      const pr = await createLocalPr(repo, { title: "Logs", body: "b", base: "main" });
      const prefix = pr.id.slice(0, 6);
      await runLoopCi(repo, prefix, {
        checks: ["test"],
        skipCache: true,
        skipToolchainEnsure: true,
        parallel: false,
        timeout: 15_000,
      });
      const common = await gitCommonDir(repo);
      const logDir = path.join(common, "agent-console", "ci-logs", pr.id);
      const logPath = path.join(logDir, "test.log");
      const body = await readFile(logPath, "utf8");
      assert.match(body, /MARKER-LOOP/);
      await setLocalPrStatus(repo, pr.id, "reviewed");
      const ciDir = pr.worktreePath && existsSync(pr.worktreePath) ? pr.worktreePath : repo;
      await writeFile(
        join(ciDir, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            build: "exit 0",
            test: 'node -e "console.error(\\"MARKER-SHEPHERD\\"); process.exit(1)"',
          },
        }),
      );
      await shepherdStatus(repo, prefix, {
        skipGithubCheck: true,
        skipToolchainEnsure: true,
        parallel: false,
        selection: {
          checks: ["test"],
          reason: ["fixture: shepherd log path"],
          mapping: [{ check: "test", reason: "fixture" }],
          uncertain: false,
          changedPaths: ["packages/core/src/ci-select.ts"],
        },
      });
      const shepherdLog = path.join(common, "agent-console", "ci-logs", pr.id, "test.log");
      const shepherdBody = await readFile(shepherdLog, "utf8");
      assert.match(shepherdBody, /MARKER-SHEPHERD/);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-136: fail progress event and result logPath point into the loop dir", async () => {
    const repo = await initRepo();
    try {
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: {
            "format:check": "exit 0",
            lint: "exit 0",
            typecheck: "exit 0",
            build: "exit 0",
            test: 'node -e "console.error(\\"MARKER-FAIL\\"); process.exit(1)"',
          },
        }),
      );
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "fail"]);
      const pr = await createLocalPr(repo, { title: "Fail path", body: "b", base: "main" });
      let failLog: string | undefined;
      const result = await runLoopCi(repo, pr.id, {
        checks: ["test"],
        skipCache: true,
        skipToolchainEnsure: true,
        parallel: false,
        timeout: 15_000,
        onProgress: (e) => {
          if (e.state === "fail" && e.logPath) failLog = e.logPath;
        },
      });
      const check = result.checks.find((c) => c.name === "test");
      assert.ok(
        check?.logPath?.includes(`ci-logs${path.sep}${pr.id}`) ||
          check?.logPath?.includes(`ci-logs/${pr.id}`),
      );
      assert.ok(failLog?.includes(pr.id));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-136: four concurrent runs with different loop ids keep separate logs", async () => {
    const repo = await initRepo();
    const worktrees: string[] = [];
    let wtParent: string | undefined;
    try {
      const loopIds = ["lp-11111111", "lp-22222222", "lp-33333333", "lp-44444444"] as const;
      const slotTiming = { pollMs: 20, maxWaitMs: 5000, noticeMs: 50 };
      wtParent = await mkdtemp(join(tmpdir(), "prgenie-ci-logs-wts-"));
      const parent = wtParent;
      for (const loopId of loopIds) {
        const wt = join(parent, loopId);
        await git(repo, ["worktree", "add", "--detach", wt]);
        worktrees.push(wt);
        await writeFile(
          join(wt, "package.json"),
          JSON.stringify({
            name: "test-repo",
            scripts: {
              "format:check": "exit 0",
              lint: "exit 0",
              typecheck: "exit 0",
              build: "exit 0",
              test: `node -e "console.error('MARKER-${loopId}'); process.exit(1)"`,
            },
          }),
        );
      }
      await Promise.all(
        loopIds.map((loopId) =>
          runCiChecks(join(parent, loopId), {
            checks: ["test"],
            skipCache: true,
            skipToolchainEnsure: true,
            parallel: false,
            timeout: 15_000,
            loopId,
            heavyConcurrency: 4,
            heavySlotTiming: slotTiming,
          }),
        ),
      );
      const common = await gitCommonDir(repo);
      for (const loopId of loopIds) {
        const logPath = path.join(common, "agent-console", "ci-logs", loopId, "test.log");
        const body = await readFile(logPath, "utf8");
        assert.match(body, new RegExp(`MARKER-${loopId}`));
        for (const other of loopIds) {
          if (other === loopId) continue;
          assert.doesNotMatch(body, new RegExp(`MARKER-${other}`));
        }
        const latestRaw = await readFile(
          path.join(common, "agent-console", "ci-logs", loopId, "latest.json"),
          "utf8",
        );
        const latest = JSON.parse(latestRaw) as { loopId?: string; excerpt?: string };
        assert.equal(latest.loopId, loopId);
        assert.match(latest.excerpt ?? "", new RegExp(`MARKER-${loopId}`));
      }
    } finally {
      for (const wt of worktrees) {
        await git(repo, ["worktree", "remove", "--force", wt]).catch(() => undefined);
      }
      if (wtParent) await rm(wtParent, { recursive: true, force: true }).catch(() => undefined);
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
