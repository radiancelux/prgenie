import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
  CI_EXCERPT_MAX_CHARS,
  collectExecOutput,
  formatCiCheckError,
  formatFailureExcerpt,
  lastNonEmptyLines,
  latestCiFailure,
  listCiFailureLogs,
  parseFirstFailingTest,
  parseGateExcerpt,
  stripAnsi,
  writeCiFailureLog,
} from "./ci-failure.js";

const execAsync = promisify(exec);

describe("ci failure excerpts", () => {
  it("prefers the first failing node:test / TAP name", () => {
    const tap = [
      "# Subtest: formats CLI lines",
      "ok 1 - helper",
      "not ok 2 - formats CLI lines",
      "  ---",
      "  error: 'Expected values to be strictly equal'",
      "  ...",
      "# fail 1",
    ].join("\n");
    assert.equal(parseFirstFailingTest(tap), "not ok 2 - formats CLI lines");
    assert.equal(parseGateExcerpt("test", tap), "not ok 2 - formats CLI lines");
  });

  it("parses node:test spec, Jest, Vitest, and Mocha names", () => {
    assert.match(parseFirstFailingTest("✖ formats CLI lines (3.4ms)") ?? "", /formats CLI lines/);
    assert.equal(
      parseFirstFailingTest("● export gate > names the check"),
      "● export gate > names the check",
    );
    assert.match(parseFirstFailingTest("× widget renders") ?? "", /widget renders/);
    assert.equal(parseFirstFailingTest("  1) lint fails on leftover"), "1) lint fails on leftover");
    assert.equal(
      parseFirstFailingTest("FAIL packages/core/src/foo.test.ts"),
      "FAIL packages/core/src/foo.test.ts",
    );
  });

  it("picks a useful lint / typecheck / format / build line", () => {
    const lint = [
      "packages/core/src/foo.ts",
      "  12:3  error  Unexpected var  no-var",
      "✖ 1 problem (1 error, 0 warnings)",
    ].join("\n");
    assert.match(parseGateExcerpt("lint", lint) ?? "", /no-var|foo\.ts/);
    const tsc =
      "packages/core/src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    assert.match(parseGateExcerpt("typecheck", tsc) ?? "", /TS2322/);
    assert.match(
      parseGateExcerpt("format:check", "Prettier format check failed for 2 file(s): a.ts, b.ts") ??
        "",
      /Prettier format check failed/,
    );
    assert.match(
      parseGateExcerpt("build", "ERROR: esbuild failed with 1 error") ?? "",
      /esbuild failed/,
    );
  });

  it("falls back to last N non-noise lines and flattens for toast", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    lines.unshift("Command failed: pnpm lint");
    const excerpt = formatFailureExcerpt("lint", {
      firstLine: "Command failed: pnpm lint",
      stdout: "",
      stderr: lines.join("\n"),
      combined: lines.join("\n"),
    });
    assert.ok(!excerpt.includes("Command failed"));
    assert.ok(excerpt.includes("line-19"));
    assert.ok(excerpt.includes(" · "));
    assert.ok(excerpt.length <= CI_EXCERPT_MAX_CHARS);
  });

  it("strips ANSI and collects exec stdout/stderr", () => {
    const esc = String.fromCharCode(27);
    assert.equal(stripAnsi(`${esc}[31mred${esc}[0m`), "red");
    const err = Object.assign(new Error("Command failed: pnpm test"), {
      stdout: "",
      stderr: "not ok 1 - widget renders\n",
    });
    const out = collectExecOutput(err);
    assert.match(out.firstLine, /Command failed/);
    assert.match(out.stderr, /widget renders/);
    assert.match(formatFailureExcerpt("test", out), /widget renders/);
  });

  it("truncates lastNonEmptyLines and formats the check error with a log path", () => {
    const text = ["keep-a", "", "npm ERR! noise", "keep-b"].join("\n");
    assert.equal(lastNonEmptyLines(text, 8), "keep-a\nkeep-b");
    assert.equal(
      formatCiCheckError({
        command: "pnpm test",
        excerpt: "not ok 1 - foo",
        logPath: ".git/agent-console/ci-logs/test.log",
      }),
      "pnpm test — not ok 1 - foo — full log: .git/agent-console/ci-logs/test.log",
    );
  });

  it("RAD-136: writeCiFailureLog writes under ci-logs/<loopId>/", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-loop-"));
    try {
      await execAsync("git init", { cwd: repo });
      const display = await writeCiFailureLog(
        repo,
        "test",
        "pnpm test",
        {
          firstLine: "fail",
          stdout: "",
          stderr: "not ok 1 - widget\n",
          combined: "not ok 1 - widget\n",
        },
        "not ok 1 - widget",
        "failed",
        "lp-12345678",
      );
      assert.match(display ?? "", /ci-logs[\\/]lp-12345678/);
      const latest = await latestCiFailure(repo, "lp-12345678");
      assert.equal(latest?.loopId, "lp-12345678");
      assert.equal(latest?.check, "test");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-136: loop key falls back to the .loops worktree id, then the shared dir", async () => {
    const primary = await mkdtemp(join(tmpdir(), "prgenie-primary-"));
    const loops = join(path.dirname(primary), `${path.basename(primary)}.loops`);
    const loopPath = join(loops, "lp-aabbccdd");
    try {
      await execAsync("git init", { cwd: primary });
      await mkdir(loopPath, { recursive: true });
      await execAsync("git init", { cwd: loopPath });
      await writeCiFailureLog(
        loopPath,
        "lint",
        "pnpm lint",
        { firstLine: "x", stdout: "", stderr: "err\n", combined: "err\n" },
        "err",
        "failed",
      );
      const scoped = await latestCiFailure(loopPath, "lp-aabbccdd");
      assert.equal(scoped?.check, "lint");
      await writeCiFailureLog(
        primary,
        "build",
        "pnpm build",
        { firstLine: "x", stdout: "", stderr: "b\n", combined: "b\n" },
        "b",
        "failed",
      );
      const shared = await latestCiFailure(primary);
      assert.equal(shared?.loopId ?? null, null);
    } finally {
      await rm(primary, { recursive: true, force: true });
      await rm(loops, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("RAD-136: invalid loop ids never escape ci-logs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-bad-"));
    try {
      await execAsync("git init", { cwd: repo });
      for (const bad of ["", "..", "../x", "a/b", "a.b"]) {
        const display = await writeCiFailureLog(
          repo,
          "test",
          "pnpm test",
          { firstLine: "f", stdout: "", stderr: "e\n", combined: "e\n" },
          "e",
          "failed",
          bad,
        );
        assert.ok(display);
        assert.doesNotMatch(display ?? "", /\.\./);
        assert.match(display ?? "", /ci-logs[\\/]test\.log$/);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-136: latest.json is replaced atomically", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-atomic-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeCiFailureLog(
        repo,
        "lint",
        "pnpm lint",
        { firstLine: "f", stdout: "", stderr: "e\n", combined: "e\n" },
        "e",
        "failed",
        "lp-deadbeef",
      );
      const common = await import("./git.js").then((m) => m.gitCommonDir(repo));
      const latestPath = join(common, "agent-console", "ci-logs", "lp-deadbeef", "latest.json");
      const raw = await readFile(latestPath, "utf8");
      JSON.parse(raw);
      const dir = join(common, "agent-console", "ci-logs", "lp-deadbeef");
      const names = (await readdir(dir)).filter(
        (n) => n.startsWith("latest.") && n.endsWith(".json") && n !== "latest.json",
      );
      assert.equal(names.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-136: latestCiFailure scopes to one loop and never falls back", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-scope-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeCiFailureLog(
        repo,
        "a",
        "pnpm a",
        { firstLine: "f", stdout: "", stderr: "1\n", combined: "1\n" },
        "1",
        "failed",
        "lp-11111111",
      );
      await writeCiFailureLog(
        repo,
        "b",
        "pnpm b",
        { firstLine: "f", stdout: "", stderr: "2\n", combined: "2\n" },
        "2",
        "failed",
        "lp-22222222",
      );
      assert.equal((await latestCiFailure(repo, "lp-11111111"))?.check, "a");
      assert.equal(await latestCiFailure(repo, "lp-99999999"), null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-136: listCiFailureLogs never returns another loop's logs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-list-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeCiFailureLog(
        repo,
        "a",
        "pnpm a",
        { firstLine: "f", stdout: "", stderr: "1\n", combined: "1\n" },
        "1",
        "failed",
        "lp-11111111",
      );
      await writeCiFailureLog(
        repo,
        "b",
        "pnpm b",
        { firstLine: "f", stdout: "", stderr: "2\n", combined: "2\n" },
        "2",
        "failed",
        "lp-22222222",
      );
      const one = await listCiFailureLogs(repo, "lp-11111111");
      assert.ok(one.every((e) => e.loopId === "lp-11111111"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-136: readers without a loop id cover all loops and the shared dir", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-all-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeCiFailureLog(
        repo,
        "shared",
        "pnpm shared",
        { firstLine: "f", stdout: "", stderr: "s\n", combined: "s\n" },
        "s",
        "failed",
      );
      await writeCiFailureLog(
        repo,
        "loop",
        "pnpm loop",
        { firstLine: "f", stdout: "", stderr: "l\n", combined: "l\n" },
        "l",
        "failed",
        "lp-33333333",
      );
      const all = await listCiFailureLogs(repo);
      const keys = new Set(all.map((e) => e.loopId ?? null));
      assert.ok(keys.has(null));
      assert.ok(keys.has("lp-33333333"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("RAD-136: legacy shared logs stay readable as shared", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-legacy-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeCiFailureLog(
        repo,
        "test",
        "pnpm test",
        {
          firstLine: "Command failed: pnpm test",
          stdout: "",
          stderr: "legacy\n",
          combined: "legacy\n",
        },
        "legacy",
      );
      const latest = await latestCiFailure(repo);
      assert.equal(latest?.loopId ?? null, null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("writes a capped log under .git/agent-console/ci-logs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeFile(join(repo, "README.md"), "x\n");
      const display = await writeCiFailureLog(
        repo,
        "test",
        "pnpm test",
        {
          firstLine: "Command failed: pnpm test",
          stdout: "",
          stderr: "not ok 1 - widget renders\n",
          combined: "not ok 1 - widget renders\n",
        },
        "not ok 1 - widget renders",
      );
      assert.ok(display);
      assert.match(display ?? "", /ci-logs/);
      const latest = await latestCiFailure(repo);
      assert.equal(latest?.check, "test");
      assert.match(latest?.excerpt ?? "", /widget renders/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
