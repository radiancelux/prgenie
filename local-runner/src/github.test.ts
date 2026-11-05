import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerdictFromText } from "./github.js";

describe("parseVerdictFromText", () => {
  it("finds APPROVE on last verdict line", () => {
    assert.equal(parseVerdictFromText("Looks good.\n\nVERDICT: APPROVE\n"), "APPROVE");
  });

  it("finds CHANGES", () => {
    assert.equal(parseVerdictFromText("Please fix tests.\nVERDICT: CHANGES"), "CHANGES");
  });

  it("returns null when missing", () => {
    assert.equal(parseVerdictFromText("no verdict here"), null);
  });
});
