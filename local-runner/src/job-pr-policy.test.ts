import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jobExpectsPr, resolvePostBuildNoPr } from "./job-pr-policy.js";

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
});
