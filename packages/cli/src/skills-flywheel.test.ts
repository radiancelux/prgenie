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

test("/steward skill is hard steward-only and refuses MCP-unavailable DIY", () => {
  const names = new Set(readdirSync(skillsRoot));
  assert.equal(names.has("steward"), true, "steward skill folder");
  assert.equal(names.has("loop"), false, "/loop must not remain as a steward alias");
  const body = skillBody("steward");
  assert.match(body, /^name:\s*steward\s*$/m);
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
  assert.match(body, /\/steward/);
  assert.doesNotMatch(body, /Those listens are transitional/);
  assert.doesNotMatch(body, /\/loop(?!-)/);
});

test("/start skill stays implementor-only and does not arm listen", () => {
  const body = skillBody("start");
  assert.match(body, /You are the \*\*implementor\*\*/);
  assert.match(body, /This skill is \*\*implementor-only\*\*/);
  assert.match(body, /It is not `\/steward`/);
  assert.match(body, /Switch \/ open `worktreePath`/);
  assert.match(body, /\.loops\/<id>/);
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

test("/review skill points at stack-agnostic process bar (RAD-103)", () => {
  const body = skillBody("review");
  const barPath = path.join(skillsRoot, "review", "process-bar.md");
  assert.equal(existsSync(barPath), true);
  const bar = readFileSync(barPath, "utf8");
  assert.match(body, /process-bar\.md/);
  assert.match(body, /\.prgenie\/review\.md/);
  assert.doesNotMatch(body, /Parler|Foundry/);
  assert.match(bar, /VERDICT: CLEAN \| ISSUES_FOUND/);
  assert.match(bar, /SYSTEM IMPACT/);
  assert.match(bar, /REGRESSIONS/);
  assert.match(bar, /HIGH[\s\S]*MEDIUM/);
  assert.match(bar, /package\.json/);
  assert.match(bar, /\.prgenie\/review\.md/);
  assert.doesNotMatch(bar, /Parler|Foundry/);
  const steward = skillBody("steward");
  assert.match(steward, /token-thin/);
  assert.match(steward, /process-bar\.md/);
  assert.match(steward, /Do \*\*not\*\* paste the process bar/);
});

test("review process bar requires the reviewer CI backstop (RAD-154)", () => {
  const bar = readFileSync(path.join(skillsRoot, "review", "process-bar.md"), "utf8");
  const reviewSkill = skillBody("review");
  const reviewerAgent = readFileSync(
    path.join(pluginRoot, "agents", "prgenie-reviewer.md"),
    "utf8",
  );
  for (const cmd of [
    "pnpm build",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm exec prettier --check --end-of-line auto .",
  ]) {
    assert.match(bar, new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(bar, /readyCi/);
  assert.match(
    bar,
    /node node_modules\/tsx\/dist\/cli\.mjs --test "packages\/\*\/src\/\*\*\/\*\.test\.ts"/,
  );
  assert.match(bar, /HIGH.*add_comment.*role=reviewer/s);
  assert.match(bar, /pnpm install --frozen-lockfile/);
  assert.match(reviewSkill, /re-run the reviewer CI backstop/);
  assert.match(reviewerAgent, /reviewer CI backstop/);
  assert.match(bar, /not defined/);
  assert.doesNotMatch(bar, /Missing green ready is a process note/);
  assert.match(bar, /BACKSTOP:/);
});

test("steward skill names PR Genie subagent types (RAD-89)", () => {
  const steward = skillBody("steward");
  assert.match(steward, /Model tiers \(RAD-89\)/);
  assert.match(steward, /prgenie-implementor/);
  assert.match(steward, /prgenie-implementor-strong/);
  assert.match(steward, /prgenie-reviewer/);
  assert.match(steward, /Never Task `generalPurpose`/);

  const localPr = skillBody("local-pr");
  assert.match(localPr, /prgenie-implementor/);
  assert.match(localPr, /never `generalPurpose`/i);

  const agentsDir = path.join(pluginRoot, "agents");
  assert.equal(existsSync(path.join(agentsDir, "prgenie-implementor.md")), true);
  assert.equal(existsSync(path.join(agentsDir, "prgenie-implementor-strong.md")), true);
  assert.equal(existsSync(path.join(agentsDir, "prgenie-reviewer.md")), true);
});
