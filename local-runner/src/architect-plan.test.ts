import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_IMPLEMENT_PROMPT } from "./prompts.js";
import {
  ARCHITECT_PLAN_HEADING,
  CODE_ARCHITECT_PLAN_SECTION,
  DOCS_ARCHITECT_OUTLINE_SECTION,
  PSTACK_ARCHITECT_ATTRIBUTION,
  promptIncludesArchitectPlanSection,
} from "./architect-plan.js";
import { DOCS_MARKETING_PROMPT, DOCS_POLICY_PROMPT, DOCS_RESEARCH_PROMPT } from "./docs-prompts.js";
import { CODE_PROVE_IT_WORKS_SECTION } from "./prove-it-works.js";

describe("architect plan prompt contract (#247)", () => {
  it("default code implement prompt requires a plan before code and keeps prove-it-works", () => {
    const planIdx = DEFAULT_IMPLEMENT_PROMPT.indexOf(CODE_ARCHITECT_PLAN_SECTION);
    const proveIdx = DEFAULT_IMPLEMENT_PROMPT.indexOf(CODE_PROVE_IT_WORKS_SECTION);
    assert.ok(planIdx >= 0, "missing architect section");
    assert.ok(proveIdx >= 0, "missing prove-it-works section");
    assert.ok(planIdx < proveIdx, "architect section must precede prove-it-works");
    assert.match(DEFAULT_IMPLEMENT_PROMPT, /types.*signatures/i);
    assert.match(DEFAULT_IMPLEMENT_PROMPT, /two shapes/i);
    assert.match(DEFAULT_IMPLEMENT_PROMPT, new RegExp(ARCHITECT_PLAN_HEADING.replace(":", "\\:")));
    assert.ok(DEFAULT_IMPLEMENT_PROMPT.includes(PSTACK_ARCHITECT_ATTRIBUTION));
    assert.match(DEFAULT_IMPLEMENT_PROMPT, /gh pr create --draft/);
    assert.match(DEFAULT_IMPLEMENT_PROMPT, /Do not merge/);
  });

  it("default docs implement prompts require an outline, not type sketches", () => {
    for (const prompt of [DOCS_MARKETING_PROMPT, DOCS_POLICY_PROMPT, DOCS_RESEARCH_PROMPT]) {
      assert.ok(prompt.includes(DOCS_ARCHITECT_OUTLINE_SECTION));
      assert.match(prompt, new RegExp(ARCHITECT_PLAN_HEADING.replace(":", "\\:")));
      assert.match(prompt, /Do not sketch types/i);
      assert.ok(prompt.includes(PSTACK_ARCHITECT_ATTRIBUTION));
      assert.ok(promptIncludesArchitectPlanSection(prompt));
    }
  });

  it("detects architect sections in default implement prompts only", () => {
    assert.equal(promptIncludesArchitectPlanSection(DEFAULT_IMPLEMENT_PROMPT), true);
    assert.equal(promptIncludesArchitectPlanSection("Build the feature.\n"), false);
  });
});
