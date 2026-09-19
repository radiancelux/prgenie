import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCiPath, DEFAULT_CI_CHECKS, selectCiChecks } from "./ci-select.js";

describe("selectCiChecks", () => {
  it("runs the full suite when paths are empty or unknown", () => {
    const empty = selectCiChecks([]);
    assert.equal(empty.uncertain, true);
    assert.deepEqual(empty.checks, [...DEFAULT_CI_CHECKS]);
    assert.match(empty.reason, /no changed paths/);

    const unknown = selectCiChecks(["assets/logo.png"]);
    assert.equal(unknown.uncertain, true);
    assert.deepEqual(unknown.checks, [...DEFAULT_CI_CHECKS]);
    assert.match(unknown.reason, /uncertain/);
  });

  it("selects format only for docs/markdown-only diffs", () => {
    const result = selectCiChecks(["README.md", "docs/architecture.md", "LICENSE"]);
    assert.equal(result.uncertain, false);
    assert.deepEqual(result.checks, ["format:check"]);
    assert.match(result.reason, /docs\/markdown-only/);
    assert.ok(!result.checks.includes("test"));
    assert.ok(!result.checks.includes("lint"));
  });

  it("runs the full suite when config or CI scripts change", () => {
    const result = selectCiChecks(["package.json", "README.md"]);
    assert.equal(result.uncertain, false);
    assert.deepEqual(result.checks, [...DEFAULT_CI_CHECKS]);
    assert.match(result.reason, /config\/CI/);
  });

  it("maps packages/cli source to lint/test (full code suite)", () => {
    const result = selectCiChecks(["packages/cli/src/cli.ts"]);
    assert.equal(result.uncertain, false);
    assert.ok(result.checks.includes("lint"));
    assert.ok(result.checks.includes("test"));
    assert.ok(result.checks.includes("typecheck"));
    assert.match(result.reason, /cli/);
  });

  it("never silently drops a required check when mapping is mixed with unknowns", () => {
    const result = selectCiChecks(["README.md", "bin/mystery.bin"]);
    assert.equal(result.uncertain, true);
    assert.deepEqual(result.checks, [...DEFAULT_CI_CHECKS]);
  });

  it("classifies test, source, docs, and config paths", () => {
    assert.equal(classifyCiPath("packages/core/src/ci-select.test.ts"), "test");
    assert.equal(classifyCiPath("packages/core/src/ci-select.ts"), "source");
    assert.equal(classifyCiPath("docs/ci-checks.md"), "docs");
    assert.equal(classifyCiPath(".github/workflows/ci.yml"), "config");
    assert.equal(classifyCiPath("scripts/build.mjs"), "config");
  });
});
