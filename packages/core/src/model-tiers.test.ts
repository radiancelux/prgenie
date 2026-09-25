import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTOR_SUBAGENT_CHEAP,
  IMPLEMENTOR_SUBAGENT_STRONG,
  isDesignHeavyBrief,
  resolveImplementorTierHint,
} from "./model-tiers.js";

test("resolveImplementorTierHint defaults to cheap", () => {
  const hint = resolveImplementorTierHint({
    body: "Fix the widget tooltip.",
    status: "draft",
    failedAcRoundCount: 0,
  });
  assert.equal(hint.tier, "cheap");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_CHEAP);
  assert.equal(hint.bumpReason, null);
});

test("resolveImplementorTierHint bumps to strong for design-heavy brief", () => {
  const hint = resolveImplementorTierHint({
    body: "RAD-1: design-heavy API architecture for the steward flywheel.",
    status: "draft",
    failedAcRoundCount: 0,
  });
  assert.equal(hint.tier, "strong");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_STRONG);
  assert.match(hint.bumpReason ?? "", /design-heavy/i);
});

test("resolveImplementorTierHint bumps after two failed AC rounds with open AC", () => {
  const hint = resolveImplementorTierHint({
    body: "Fix the button color.",
    status: "changes_requested",
    failedAcRoundCount: 2,
  });
  assert.equal(hint.tier, "strong");
  assert.match(hint.bumpReason ?? "", /two implementor rounds/i);
});

test("resolveImplementorTierHint CI-resume spawn stays cheap", () => {
  const hint = resolveImplementorTierHint(
    {
      body: "RAD-1: design-heavy architecture rewrite.",
      status: "reviewed",
      failedAcRoundCount: 0,
    },
    { ciResume: true },
  );
  assert.equal(hint.tier, "cheap");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_CHEAP);
});

test("isDesignHeavyBrief detects explicit marker and keywords", () => {
  assert.equal(isDesignHeavyBrief("plain bugfix"), false);
  assert.equal(isDesignHeavyBrief("Needs architecture for the new module"), true);
  assert.equal(isDesignHeavyBrief("This AC is design-heavy"), true);
});
