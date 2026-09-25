import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  CI_EXCERPT_MAX_CHARS,
  collectShellOutput,
  failureExcerptContextFromError,
  formatFailureExcerpt,
  writeCiFailureLog,
} from "./ci-failure.js";
import { CiShellError } from "./ci-kill.js";

const execAsync = promisify(exec);

describe("ci failure excerpt priority (RAD-137)", () => {
  it("timeout leads with check name and seconds, then optional TAP tail", () => {
    const tap = [
      "ok 1 - helper still running",
      "ok 2 - another passing line",
      "# still waiting",
    ].join("\n");
    const output = {
      firstLine: "Command timed out after 5000ms",
      stdout: tap,
      stderr: "",
      combined: tap,
    };
    const excerpt = formatFailureExcerpt("test:core", output, {
      kind: "timeout",
      timeoutSec: 5,
    });
    assert.match(excerpt, /test:core timed out after 5s/);
    assert.ok(excerpt.includes("ok 2") || excerpt.includes("passing"));
    assert.ok(excerpt.length <= CI_EXCERPT_MAX_CHARS);
  });

  it("cancelled is explicit and beats TAP tail", () => {
    const output = {
      firstLine: "Cancelled",
      stdout: "ok 1 - would mislead\n",
      stderr: "",
      combined: "ok 1 - would mislead\n",
    };
    const excerpt = formatFailureExcerpt("lint:core", output, { kind: "cancelled" });
    assert.match(excerpt, /lint:core cancelled/);
    assert.ok(!excerpt.includes("ok 1"));
  });

  it("maxBuffer and spawn errors are named", () => {
    const output = collectShellOutput(
      new CiShellError({
        kind: "maxBuffer",
        message: "maxBuffer exceeded",
        stdout: "partial",
        stderr: "",
      }),
    );
    assert.match(formatFailureExcerpt("test", output, { kind: "maxBuffer" }), /max buffer/);

    const spawnOut = collectShellOutput(new Error("spawn pnpm ENOENT"));
    assert.match(formatFailureExcerpt("lint", spawnOut, { kind: "spawn" }), /lint spawn failed/);
  });

  it("real TAP failure still shows the first not ok", () => {
    const tap = [
      "ok 1 - helper",
      "not ok 2 - widget renders",
      "  error: 'Expected values to be strictly equal'",
    ].join("\n");
    const output = { firstLine: "Command failed", stdout: tap, stderr: "", combined: tap };
    const excerpt = formatFailureExcerpt("test:core", output);
    assert.match(excerpt, /not ok 2 - widget renders/);
    assert.ok(!excerpt.includes("timed out"));
  });

  it("failureExcerptContextFromError maps CiShellError and legacy exec fields", () => {
    const timeoutErr = new CiShellError({
      kind: "timeout",
      message: "Command timed out after 120000ms",
      timeoutMs: 120_000,
    });
    assert.deepEqual(failureExcerptContextFromError(timeoutErr), {
      kind: "timeout",
      timeoutSec: 120,
    });

    const legacy = Object.assign(new Error("Command timed out"), {
      killed: true,
      signal: "SIGTERM",
    });
    assert.deepEqual(failureExcerptContextFromError(legacy, 90_000), {
      kind: "timeout",
      timeoutSec: 90,
    });

    const buf = Object.assign(new Error("maxBuffer exceeded"), { code: "ENOBUFS" });
    assert.deepEqual(failureExcerptContextFromError(buf), { kind: "maxBuffer" });
  });

  it("writeCiFailureLog header names timed out or cancelled, not only failed", async () => {
    const repo = await mkdtemp(join(tmpdir(), "prgenie-ci-log-outcome-"));
    try {
      await execAsync("git init", { cwd: repo });
      await writeFile(join(repo, "README.md"), "x\n");
      const output = {
        firstLine: "Command timed out after 1200000ms",
        stdout: "ok 1 - still running\n",
        stderr: "",
        combined: "ok 1 - still running\n",
      };
      await writeCiFailureLog(
        repo,
        "test:core",
        "pnpm test",
        output,
        "test:core timed out after 1200s",
        "timed out",
      );
      const logText = await readFile(
        join(repo, ".git", "agent-console", "ci-logs", "test_core.log"),
        "utf8",
      );
      assert.match(logText, /test:core \(pnpm test\) timed out /);
      assert.doesNotMatch(logText, /\) failed /);

      await writeCiFailureLog(
        repo,
        "lint:core",
        "pnpm lint",
        { firstLine: "Cancelled", stdout: "", stderr: "", combined: "" },
        "lint:core cancelled",
        "cancelled",
      );
      const cancelLog = await readFile(
        join(repo, ".git", "agent-console", "ci-logs", "lint_core.log"),
        "utf8",
      );
      assert.match(cancelLog, /lint:core \(pnpm lint\) cancelled /);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("collectShellOutput appends CiShellError kill notes to combined output", () => {
    const output = collectShellOutput(
      new CiShellError({
        kind: "timeout",
        message: "Command timed out after 5000ms",
        stdout: "partial",
        stderr: "",
        notes: ["tree kill incomplete: access denied"],
      }),
    );
    assert.match(output.combined, /tree kill incomplete: access denied/);
    assert.match(output.combined, /partial/);
  });
});
