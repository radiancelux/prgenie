import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugin");
const skillsRoot = path.join(pluginRoot, "skills");
const rulePath = path.join(pluginRoot, "rules", "no-remote-pr.mdc");

function skillBody(name: string): string {
  return readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
}

test("listen slash skills are gone", () => {
  const names = new Set(readdirSync(skillsRoot));
  for (const banned of [
    "watch-inbox",
    "watch-ready",
    "inbox",
    "queue",
    "unwatch",
    "stop",
    "stop-review",
    "start-loop",
    "watch-ready-prs",
    "watch-review-inbox",
  ]) {
    assert.equal(existsSync(path.join(skillsRoot, banned, "SKILL.md")), false, banned);
    assert.equal(names.has(banned), false, banned);
  }
});

test("/loop skill is hard steward-only and refuses MCP-unavailable DIY", () => {
  const body = skillBody("loop");
  assert.match(body, /You are the \*\*steward only\*\*/);
  assert.match(body, /Do \*\*not\*\* write product code/);
  assert.match(body, /while MCP loads/);
  assert.match(body, /watch-inbox/);
  assert.match(body, /STOP/);
  assert.match(body, /Never fall through to a CLI DIY flywheel/);
  assert.match(body, /steward_next/);
  assert.match(body, /bind_steward/);
  assert.match(body, /Resume the same implementor Task id/);
  assert.match(body, /handoff_human/);
  assert.doesNotMatch(body, /Those listens are transitional/);
});

test("/start skill stays implementor-only and does not arm listen", () => {
  const body = skillBody("start");
  assert.match(body, /You are the \*\*implementor\*\*/);
  assert.match(body, /This skill is \*\*implementor-only\*\*/);
  assert.match(body, /It is not `\/loop`/);
  assert.doesNotMatch(body, /start \*\*`\/watch-inbox`\*\*/);
  assert.doesNotMatch(body, /\/watch-ready`\*\*/);
});

test("no-remote-pr.mdc distinguishes steward vs implementor and bans listen", () => {
  const rule = readFileSync(rulePath, "utf8");
  assert.match(rule, /\*\*Steward only\*\*/);
  assert.match(rule, /\*\*Implementor only\*\*/);
  assert.match(rule, /There is no inbox\/queue listen flywheel/);
  assert.match(rule, /Never CLI DIY/);
  assert.doesNotMatch(rule, /Inbox\/queue listen \(`\/watch-inbox`/);
});
