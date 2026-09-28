import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { rm, writeFile } from "node:fs/promises";
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
      await shepherdStatus(repo, prefix, {
        skipGithubCheck: true,
        skipCache: true,
        skipToolchainEnsure: true,
        parallel: false,
        timeout: 15_000,
        selection: {
          checks: ["test"],
          reason: ["fixture: shepherd log path"],
          mapping: [{ check: "test", reason: "fixture" }],
          uncertain: false,
          changedPaths: ["packages/core/src/ci-select.ts"],
        },
        packageScripts: {
          test: 'node -e "console.error(\\"MARKER-SHEPHERD\\"); process.exit(1)"',
          lint: "exit 0",
          typecheck: "exit 0",
          build: "exit 0",
          "format:check": "exit 0",
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
    try {
      const loopIds = ["lp-11111111", "lp-22222222", "lp-33333333", "lp-44444444"] as const;
      // Source path (not package.json) so host-scope stays open and packageScripts run.
      const fixturePaths = ["packages/core/src/ci-select.ts"];
      await Promise.all(
        loopIds.map((loopId) =>
          runCiChecks(repo, {
            checks: ["test"],
            skipCache: true,
            skipToolchainEnsure: true,
            parallel: false,
            timeout: 15_000,
            loopId,
            changedPaths: fixturePaths,
            selection: {
              checks: ["test"],
              reason: ["fixture: concurrent loop logs"],
              mapping: [{ check: "test", reason: "fixture" }],
              uncertain: false,
              changedPaths: fixturePaths,
            },
            packageScripts: {
              "format:check": "exit 0",
              lint: "exit 0",
              typecheck: "exit 0",
              build: "exit 0",
              test: `node -e "console.error('MARKER-${loopId}'); process.exit(1)"`,
            },
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
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
