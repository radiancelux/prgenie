import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCiChecks, runLoopCi } from "./ci-runner.js";
import { createLocalPr } from "./prs.js";
import { git } from "./git.js";
import { gitCommonDir } from "./git.js";
import { createTempGitRepo } from "./test-git-fixture.js";

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
      assert.ok(check?.logPath?.includes(`ci-logs${path.sep}${pr.id}`) || check?.logPath?.includes(`ci-logs/${pr.id}`));
      assert.ok(failLog?.includes(pr.id));
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-136: four concurrent runs with different loop ids keep separate logs", async () => {
    const repo = await initRepo();
    try {
      const specs = [
        { loopId: "lp-11111111", check: "test", file: "test.log" },
        { loopId: "lp-22222222", check: "lint", file: "lint.log" },
        { loopId: "lp-33333333", check: "typecheck", file: "typecheck.log" },
        { loopId: "lp-44444444", check: "build", file: "build.log" },
      ] as const;
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: Object.fromEntries(
            specs.map((s) => [
              s.check,
              `node -e "console.error('MARKER-${s.loopId}'); process.exit(1)"`,
            ]),
          ),
        }),
      );
      await Promise.all(
        specs.map((s) =>
          runCiChecks(repo, {
            checks: [s.check],
            skipCache: true,
            skipToolchainEnsure: true,
            parallel: false,
            timeout: 15_000,
            loopId: s.loopId,
          }),
        ),
      );
      const common = await gitCommonDir(repo);
      for (const s of specs) {
        const logPath = path.join(common, "agent-console", "ci-logs", s.loopId, s.file);
        const body = await readFile(logPath, "utf8");
        assert.match(body, new RegExp(`MARKER-${s.loopId}`));
        for (const other of specs) {
          if (other.loopId === s.loopId) continue;
          assert.doesNotMatch(body, new RegExp(`MARKER-${other.loopId}`));
        }
      }
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
