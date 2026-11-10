import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isNoCommitsBetweenBasePrError,
  jobExpectsPr,
  NO_COMMITS_BEYOND_BASE_MESSAGE,
  NO_PR_GUARD_MESSAGE,
  resolvePostBuildNoPr,
  resolvePostBuildNoPrError,
} from "./job-pr-policy.js";

describe("job-pr-policy", () => {
  it("expects a PR by default", () => {
    assert.equal(jobExpectsPr({}), true);
    assert.equal(jobExpectsPr({ expectPr: true }), true);
    assert.equal(resolvePostBuildNoPr({}).kind, "stuck");
  });

  it("allows completion without a PR when expectPr is false", () => {
    assert.equal(jobExpectsPr({ expectPr: false }), false);
    assert.deepEqual(resolvePostBuildNoPr({ expectPr: false }), {
      kind: "complete",
      error: null,
    });
  });

  it("detects gh no-commits-between error", () => {
    assert.equal(
      isNoCommitsBetweenBasePrError("GraphQL: No commits between main and feat/x"),
      true,
    );
    assert.equal(isNoCommitsBetweenBasePrError("network error"), false);
  });

  it("uses a plain message when the branch has no commits beyond base", () => {
    const msg = resolvePostBuildNoPrError({
      input: {},
      branchMatchesBase: true,
    });
    assert.equal(msg, NO_COMMITS_BEYOND_BASE_MESSAGE);
    assert.doesNotMatch(msg, /local diff guard/);
    const fromGh = resolvePostBuildNoPrError({
      input: {},
      ensureError: "No commits between main and feat",
    });
    assert.equal(fromGh, NO_COMMITS_BEYOND_BASE_MESSAGE);
    const generic = resolvePostBuildNoPrError({ input: {} });
    assert.equal(generic, NO_PR_GUARD_MESSAGE);
  });
});
