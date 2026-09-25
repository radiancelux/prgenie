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

test("resolveImplementorTierHint bumps to strong for explicit tier marker", () => {
  const hint = resolveImplementorTierHint({
    body: "RAD-1: rewrite the packet store.\ntier: strong",
    status: "draft",
    failedAcRoundCount: 0,
  });
  assert.equal(hint.tier, "strong");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_STRONG);
  assert.match(hint.bumpReason ?? "", /explicit strong-tier marker/i);
});

test("resolveImplementorTierHint bumps to strong for design-heavy marker", () => {
  const hint = resolveImplementorTierHint({
    body: "RAD-1: design-heavy API rewrite for the steward flywheel.",
    status: "draft",
    failedAcRoundCount: 0,
  });
  assert.equal(hint.tier, "strong");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_STRONG);
  assert.match(hint.bumpReason ?? "", /explicit strong-tier marker/i);
});

test("resolveImplementorTierHint stays cheap for docs edit, race condition, and typo bodies", () => {
  for (const body of [
    "Docs: update architecture.md for the steward flywheel.",
    "Fix race condition when two stewards bind the same loop.",
    "Typo in the export gate error message.",
  ]) {
    const hint = resolveImplementorTierHint({
      body,
      status: "draft",
      failedAcRoundCount: 0,
    });
    assert.equal(hint.tier, "cheap", `expected cheap for: ${body.slice(0, 40)}`);
  }
});

test("resolveImplementorTierHint bumps after two failed AC rounds with open AC", () => {
  const hint = resolveImplementorTierHint({
    body: "Fix the button color.",
    status: "changes_requested",
    failedAcRoundCount: 2,
  });
  assert.equal(hint.tier, "strong");
  assert.match(hint.bumpReason ?? "", /two reviewer rejections/i);
});

test("resolveImplementorTierHint CI-resume spawn stays cheap", () => {
  const hint = resolveImplementorTierHint(
    {
      body: "tier: strong\nRAD-1: architecture rewrite.",
      status: "reviewed",
      failedAcRoundCount: 0,
    },
    { ciResume: true },
  );
  assert.equal(hint.tier, "cheap");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_CHEAP);
});

test("isDesignHeavyBrief detects explicit markers only", () => {
  assert.equal(isDesignHeavyBrief("plain bugfix"), false);
  assert.equal(isDesignHeavyBrief("Needs architecture for the new module"), false);
  assert.equal(isDesignHeavyBrief("Fix race condition in bind_steward"), false);
  assert.equal(isDesignHeavyBrief("This AC is design-heavy"), true);
  assert.equal(isDesignHeavyBrief("tier: strong"), true);
  assert.equal(isDesignHeavyBrief("Tier: STRONG"), true);
});
