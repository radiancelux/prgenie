import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
