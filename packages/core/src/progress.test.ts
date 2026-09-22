import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortError,
  applyCiProgressEvent,
  ciCheckCommand,
  emptyCiProgressSnapshot,
  formatElapsed,
  formatFailedCheck,
  formatProgressCard,
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

  it("formats a multi-check progress card with why and elapsed", () => {
    let snap = applyCiProgressEvent(emptyCiProgressSnapshot(), {
      phase: "ci",
      state: "start",
      selectedChecks: ["format:check", "lint"],
      selectionReason: "docs/markdown-only — format only, skip lint/test/build",
      cwd: "/tmp/pr-genie.loops/lp-demo",
    });
    snap = applyCiProgressEvent(snap, {
      phase: "ci",
      check: "format:check",
      state: "fail",
      elapsedMs: 1200,
      message: "bad.js",
    });
    const card = formatProgressCard(snap);
    assert.match(card, /CI progress/);
    assert.match(card, /Why: docs\/markdown-only/);
    assert.match(card, /Cwd: \/tmp\/pr-genie\.loops\/lp-demo/);
    assert.match(card, /format\s+fail\s+1\.2s — bad\.js/);
    assert.match(card, /lint\s+queued/);
  });

  it("names the check command and abort errors", () => {
    assert.equal(ciCheckCommand("test"), "pnpm test");
    assert.equal(ciCheckCommand("test:core"), "pnpm exec tsx --test packages/core/src/*.test.ts");
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
