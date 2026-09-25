import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTOR_SUBAGENT_CHEAP,
  IMPLEMENTOR_SUBAGENT_STRONG,
  hasStrongTierMarkerLine,
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

test("resolveImplementorTierHint bumps to strong for own-line tier marker", () => {
  const hint = resolveImplementorTierHint({
    body: "RAD-1: rewrite the packet store.\ntier: strong",
    status: "draft",
    failedAcRoundCount: 0,
  });
  assert.equal(hint.tier, "strong");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_STRONG);
  assert.match(hint.bumpReason ?? "", /explicit strong-tier marker/i);
});

test("resolveImplementorTierHint stays cheap when tier marker is inline", () => {
  const hint = resolveImplementorTierHint({
    body: "RAD-1: tier: strong rewrite for the steward flywheel.",
    status: "draft",
    failedAcRoundCount: 0,
  });
  assert.equal(hint.tier, "cheap");
  assert.equal(hint.subagentType, IMPLEMENTOR_SUBAGENT_CHEAP);
  assert.equal(hint.bumpReason, null);
});

test("resolveImplementorTierHint stays cheap for docs edit, race condition, and typo bodies", () => {
  for (const body of [
    "Docs: update architecture.md for the steward flywheel.",
    "Fix race condition when two stewards bind the same loop.",
    "Typo in the export gate error message.",
    "RAD-1: design-heavy API rewrite for the steward flywheel.",
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

test("hasStrongTierMarkerLine detects own-line tier marker only", () => {
  assert.equal(hasStrongTierMarkerLine("plain bugfix"), false);
  assert.equal(hasStrongTierMarkerLine("Needs architecture for the new module"), false);
  assert.equal(hasStrongTierMarkerLine("Fix race condition in bind_steward"), false);
  assert.equal(hasStrongTierMarkerLine("This AC is design-heavy"), false);
  assert.equal(hasStrongTierMarkerLine("RAD-1: tier: strong rewrite"), false);
  assert.equal(hasStrongTierMarkerLine("tier: strong"), true);
  assert.equal(hasStrongTierMarkerLine("Tier: STRONG"), true);
  assert.equal(hasStrongTierMarkerLine("Brief intro.\ntier: strong\nMore detail."), true);
});
