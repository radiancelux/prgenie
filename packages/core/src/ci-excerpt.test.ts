import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CI_EXCERPT_MAX_CHARS,
  collectShellOutput,
  failureExcerptContextFromError,
  formatFailureExcerpt,
} from "./ci-failure.js";
import { CiShellError } from "./ci-kill.js";

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
});
