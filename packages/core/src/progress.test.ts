import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortError,
  ciCheckCommand,
  formatElapsed,
  formatFailedCheck,
  formatProgressLine,
  formatProgressStep,
  isAbortError,
  shortCheckName,
  throwIfAborted,
} from "./progress.js";

describe("progress helpers", () => {
  it("formats CLI lines with check, command, pass/fail, and elapsed", () => {
    assert.equal(
      formatProgressLine({ phase: "ci", check: "lint", state: "start", command: "pnpm lint" }),
      "[ci:lint] running (pnpm lint)...",
    );
    assert.equal(
      formatProgressLine({ phase: "ci", check: "lint", state: "pass", elapsedMs: 1200 }),
      "[ci:lint] pass (1.2s)",
    );
    assert.equal(
      formatProgressLine({
        phase: "ci",
        check: "test",
        state: "fail",
        elapsedMs: 3400,
        command: "pnpm test",
        message: "not ok 1 - formats CLI lines",
      }),
      "[ci:test] fail (3.4s) — pnpm test — not ok 1 - formats CLI lines",
    );
    assert.equal(
      formatProgressLine({ phase: "ci", check: "lint", state: "cached", elapsedMs: 0 }),
      "[ci:lint] cached (0ms)",
    );
    assert.match(formatProgressLine({ phase: "review", state: "start" }), /\[review\] running/);
  });

  it("formats sidebar steps for gate vs full export", () => {
    assert.equal(
      formatProgressStep({ phase: "ci", check: "format:check", state: "start" }, "gate"),
      "CI checks → format",
    );
    assert.equal(
      formatProgressStep({ phase: "ci", check: "test", state: "start" }, "gate"),
      "CI checks → test",
    );
    assert.equal(formatProgressStep({ phase: "review", state: "start" }, "gate"), "Review");
    assert.equal(
      formatProgressStep({ phase: "ci", check: "test", state: "start" }, "export"),
      "CI → test",
    );
    assert.equal(formatProgressStep({ phase: "push", state: "start" }, "export"), "CI → push");
    assert.equal(
      formatProgressStep({ phase: "create_pr", state: "start" }, "export"),
      "CI → push → create PR",
    );
  });

  it("names the check command and abort errors", () => {
    assert.equal(ciCheckCommand("test"), "pnpm test");
    assert.equal(shortCheckName("format:check"), "format");
    assert.equal(formatElapsed(40), "40ms");
    assert.equal(
      formatFailedCheck({
        check: "test",
        command: "pnpm test",
        message: "not ok 1 - formats CLI lines",
        logPath: ".git/agent-console/ci-logs/test.log",
      }),
      "test — pnpm test — not ok 1 - formats CLI lines — full log: .git/agent-console/ci-logs/test.log",
    );
    const err = abortError();
    assert.equal(isAbortError(err), true);
    assert.equal(isAbortError(new Error("nope")), false);
    const ac = new AbortController();
    ac.abort();
    assert.throws(
      () => throwIfAborted(ac.signal),
      (e: unknown) => isAbortError(e),
    );
  });
});
