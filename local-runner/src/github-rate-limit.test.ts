import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhResult } from "./spawn-cmd.js";
import {
  backoffDelayMs,
  ghWithGithubRetry,
  isGithubRateLimitError,
  isGithubRateLimitResult,
} from "./github-rate-limit.js";

describe("isGithubRateLimitError", () => {
  it("detects primary and secondary limits", () => {
    assert.equal(
      isGithubRateLimitError("GraphQL: API rate limit already exceeded for user ID 1"),
      true,
    );
    assert.equal(isGithubRateLimitError("You have exceeded a secondary rate limit"), true);
    assert.equal(isGithubRateLimitError("abuse detection"), true);
    assert.equal(isGithubRateLimitError("not found"), false);
  });
});

describe("backoffDelayMs", () => {
  it("waits until reset when provided", () => {
    const now = 1_000_000_000_000;
    const reset = Math.floor((now + 30_000) / 1000);
    const delay = backoffDelayMs(0, reset, now);
    assert.ok(delay >= 29_000 && delay <= 32_000);
  });

  it("uses exponential fallback without reset", () => {
    const d0 = backoffDelayMs(0, null, 0);
    const d3 = backoffDelayMs(3, null, 0);
    assert.ok(d3 >= d0);
  });
});

describe("ghWithGithubRetry", () => {
  it("retries until a non-rate-limit response", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const gh = async (): Promise<GhResult> => {
      calls += 1;
      if (calls < 3) {
        return { code: 1, stdout: "", stderr: "rate limit already exceeded" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const res = await ghWithGithubRetry("/wt", ["api", "rate_limit"], gh, {
      maxWaitMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      lookupReset: async () => null,
    });
    assert.equal(res.code, 0);
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
  });

  it("isGithubRateLimitResult matches 403 abuse", () => {
    assert.equal(
      isGithubRateLimitResult({ code: 403, stdout: "", stderr: "403 Forbidden — abuse" }),
      true,
    );
  });
});
