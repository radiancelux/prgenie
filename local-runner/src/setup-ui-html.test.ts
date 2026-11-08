import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupUiHtml } from "./setup-ui-html.js";
import {
  MAX_ACTIVE_JOBS_MAX,
  MAX_ACTIVE_JOBS_MIN,
  MAX_ROUNDS_MAX,
  MAX_ROUNDS_MIN,
  WATCHDOG_INACTIVITY_MS_MAX,
  WATCHDOG_INACTIVITY_MS_MIN,
} from "./runner-policy.js";
import { RUNNER_MCP_TOOLS } from "./mcp-handlers.js";
import { runnerUiHtml } from "./ui-html.js";

const MAINTAINER_TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/cc-consulting-nv\/img-business/i, "example org slug"],
  [/\bhis workstation\b/i, "his workstation"],
  [/RAD-n when omitted/i, "RAD-n ticket hint"],
  [/inferred from branch RAD/i, "RAD branch inference"],
  [/issue id e\.g\.\s*\(/i, "truncated linearIssue description"],
];

function mcpDescriptionBlob(): string {
  return JSON.stringify(RUNNER_MCP_TOOLS);
}

describe("setup UI html (#145)", () => {
  const html = setupUiHtml(9475, ["http://127.0.0.1:9475/"]);

  it("exposes v2 runner policy controls", () => {
    assert.match(html, /id="defaultMaxRounds"/);
    assert.match(html, /id="maxActiveJobs"/);
    assert.match(html, /id="stageModelBuild"/);
    assert.match(html, /id="stageModelReview"/);
    assert.match(html, /id="stageModelFix"/);
    assert.match(html, /id="watchdogInactivityMs"/);
    assert.match(html, /id="computeWatchdogInactivityMs"/);
    assert.match(html, /stageModelsEffective/);
  });

  it("embeds validation bounds aligned with runner-policy", () => {
    assert.ok(html.includes(`"min":${MAX_ROUNDS_MIN}`));
    assert.ok(html.includes(`"max":${MAX_ROUNDS_MAX}`));
    assert.ok(html.includes(`"min":${MAX_ACTIVE_JOBS_MIN}`));
    assert.ok(html.includes(`"max":${MAX_ACTIVE_JOBS_MAX}`));
    assert.ok(html.includes(`"min":${WATCHDOG_INACTIVITY_MS_MIN}`));
    assert.ok(html.includes(`"max":${WATCHDOG_INACTIVITY_MS_MAX}`));
  });

  it("includes client-side validatePolicyForm before PATCH", () => {
    assert.match(html, /function validatePolicyForm/);
    assert.match(html, /must be between/);
    assert.match(html, /err-defaultMaxRounds/);
  });

  it("uses responsive layout classes for 768px (no horizontal overflow)", () => {
    assert.match(html, /overflow-x-hidden/);
    assert.match(html, /max-w-lg/);
    assert.match(html, /min-w-0 max-w-full/);
    const dom = new JSDOM(html, { url: "http://127.0.0.1:9475/setup" });
    const main = dom.window.document.querySelector("main");
    assert.ok(main?.classList.contains("overflow-x-hidden"));
    assert.ok(main?.classList.contains("max-w-lg"));
  });

  it("load and save script references policy fields", () => {
    assert.match(html, /defaultMaxRounds/);
    assert.match(html, /jobTypes:\s*\{[\s\S]*compute:\s*\{[\s\S]*watchdog/);
    assert.match(html, /applyPolicyFromLoaded/);
  });
});

describe("operator-neutral copy (#163)", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));

  it("setup page uses neutral placeholders", () => {
    const html = setupUiHtml(9473);
    assert.match(html, /your-org\/your-docs-repo/);
    assert.match(html, /runner host's workstation/);
    assert.doesNotMatch(html, /cc-consulting-nv/);
    assert.doesNotMatch(html, /\bhis workstation\b/i);
  });

  it("rejects known maintainer-specific tokens in setup, dashboard, and MCP text", async () => {
    const setupSrc = await readFile(path.join(srcDir, "setup-ui-html.ts"), "utf8");
    const uiSrc = await readFile(path.join(srcDir, "ui-html.ts"), "utf8");
    const blob = [setupSrc, uiSrc, mcpDescriptionBlob(), runnerUiHtml(9473)].join("\n");
    for (const [pattern, label] of MAINTAINER_TOKEN_PATTERNS) {
      assert.doesNotMatch(blob, pattern, `unexpected maintainer token: ${label}`);
    }
  });

  it("start_job MCP descriptions document generic branch patterns", () => {
    const tool = RUNNER_MCP_TOOLS.find((t) => t.name === "start_job");
    assert.ok(tool);
    const props = tool!.inputSchema.properties as Record<string, { description?: string }>;
    assert.match(String(props.ticketUrl.description), /issue-<n>|ticket-<n>/);
    assert.match(String(props.linearIssue.description), /ISSUE-/);
    assert.doesNotMatch(String(props.ticketUrl.description), /RAD-n/);
    assert.doesNotMatch(String(props.linearIssue.description), /e\.g\.\s*\(/);
  });
});
