import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  isGithubCli,
  isPrgenieMcpContext,
  isPublish,
  mcpHumanConfirmationGate,
  normalizeBareMcpToolName,
  switchUser,
} from "./github-hook.js";

/** Shaped like live Cursor transcript (RAD-164 follow-up); replace when log captures real payload. */
const TRANSCRIPT_SHAPED_FIXTURE = {
  tool_name: "plugin-prgenie-prgenie-export_local_pr",
  serverIdentifier: "plugin-prgenie-prgenie",
  providerIdentifier: "prgenie",
  toolName: "export_local_pr",
  tool_input: { id: "lp-deadbeef" },
} as const;

const gateCjs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../plugin/hooks/github-gate.cjs",
);

function runGate(input: Record<string, unknown>): { permission: string; agent_message?: string } {
  const result = spawnSync(process.execPath, [gateCjs], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { permission: string; agent_message?: string };
}

test("isPublish flags git push and gh pr create/merge/repo create", () => {
  assert.equal(isPublish("git push origin HEAD"), true);
  assert.equal(isPublish("git.exe push -u origin main"), true);
  assert.equal(isPublish("gh pr create --title t"), true);
  assert.equal(isPublish("gh.exe pr merge 12"), true);
  assert.equal(isPublish("gh repo create foo"), true);
  assert.equal(isPublish("git status"), false);
  assert.equal(isPublish("gh pr view 1"), false);
  assert.equal(isPublish("pnpm test"), false);
});

test("isGithubCli matches gh and git push", () => {
  assert.equal(isGithubCli("gh auth status"), true);
  assert.equal(isGithubCli("gh.exe pr list"), true);
  assert.equal(isGithubCli("git push origin HEAD"), true);
  assert.equal(isGithubCli("git commit -m x"), false);
});

test("switchUser extracts --user from gh auth switch", () => {
  assert.equal(switchUser("gh auth switch --user alice"), "alice");
  assert.equal(switchUser("gh.exe auth switch --hostname github.com --user Bob"), "Bob");
  assert.equal(switchUser("gh auth status"), null);
  assert.equal(switchUser("git push"), null);
});

test("built github-gate.cjs runs main and fail-closes push", () => {
  const bundled = readFileSync(gateCjs, "utf8");
  assert.equal(bundled.includes("ranAsCli"), false, "entry must not use ranAsCli");
  assert.equal(
    bundled.includes("import_meta"),
    false,
    "entry must not rely on blanked import_meta",
  );

  const input = JSON.stringify({
    command: "git push origin HEAD",
    cwd: process.cwd(),
  });
  const result = spawnSync(process.execPath, [gateCjs], {
    input,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().length > 0, "gate must write JSON (not silent fail-open)");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.permission, "ask");
  assert.match(String(parsed.agent_message ?? ""), /Do not git push|Ask whether|opt in/i);
});

test("built github-gate.cjs allows non-publish commands", () => {
  const parsed = runGate({ command: "git status", cwd: process.cwd() });
  assert.equal(parsed.permission, "allow");
});

test("RAD-164: mcpHumanConfirmationGate asks for human-only MCP tools", () => {
  assert.equal(mcpHumanConfirmationGate("export_local_pr", {}), "ask");
  assert.equal(mcpHumanConfirmationGate("record_export_gate_override", {}), "ask");
  assert.equal(mcpHumanConfirmationGate("gh_use", {}), "ask");
  assert.equal(mcpHumanConfirmationGate("set_status", { status: "approved" }), "ask");
  assert.equal(mcpHumanConfirmationGate("set_status", { status: "reviewed" }), "ask");
  assert.equal(
    mcpHumanConfirmationGate("set_status", { status: "ready", skipPreflight: true }),
    "ask",
  );
  assert.equal(
    mcpHumanConfirmationGate("set_status", { status: "ready", ciSkipReason: "flaky" }),
    "ask",
  );
  assert.equal(
    mcpHumanConfirmationGate("set_status", { status: "ready", ciSkipChecks: ["test:core"] }),
    "ask",
  );
  assert.equal(mcpHumanConfirmationGate("set_status", { status: "ready" }), "allow");
  assert.equal(mcpHumanConfirmationGate("add_comment", { role: "human" }), "ask");
  assert.equal(mcpHumanConfirmationGate("add_comment", {}), "ask");
  assert.equal(mcpHumanConfirmationGate("add_comment", { role: "agent" }), "allow");
  assert.equal(
    mcpHumanConfirmationGate("add_comment", {
      role: "agent",
      body: "CI skipped: toolchain missing on this machine",
    }),
    "ask",
  );
  assert.equal(mcpHumanConfirmationGate("add_comment", { role: "reviewer" }), "allow");
  assert.equal(mcpHumanConfirmationGate("get_local_pr", { id: "lp-deadbeef" }), "allow");
  assert.equal(mcpHumanConfirmationGate("set_status", null), "invalid");
  assert.equal(mcpHumanConfirmationGate("steward_next", { id: "lp-deadbeef" }), "ask");
  assert.equal(mcpHumanConfirmationGate("unknown_prgenie_tool", {}), "ask");
});

test("RAD-164: normalizeBareMcpToolName strips plugin server prefixes", () => {
  assert.equal(
    normalizeBareMcpToolName({
      tool_name: "plugin-prgenie-prgenie-export_local_pr",
      serverIdentifier: "plugin-prgenie-prgenie",
      toolName: "export_local_pr",
    }),
    "export_local_pr",
  );
});

test("RAD-164: isPrgenieMcpContext matches prgenie server names only", () => {
  assert.equal(isPrgenieMcpContext({ mcp_server_name: "plugin-prgenie-prgenie" }), true);
  assert.equal(isPrgenieMcpContext({ mcp_server_name: "user-figma" }), false);
  assert.equal(isPrgenieMcpContext({ command: "node packages/plugin/mcp/server.cjs" }), true);
  assert.equal(isPrgenieMcpContext({ tool_name: "export_local_pr" }), false);
  assert.equal(isPrgenieMcpContext({ tool_name: "plugin-prgenie-prgenie-export_local_pr" }), true);
  assert.equal(isPrgenieMcpContext({ providerIdentifier: "prgenie" }), true);
});

test("RAD-164 follow-up: transcript-shaped prefixed export_local_pr asks", () => {
  const parsed = runGate({ ...TRANSCRIPT_SHAPED_FIXTURE });
  assert.equal(parsed.permission, "ask");
  assert.match(String(parsed.agent_message ?? ""), /Human-only MCP/i);
});

test("RAD-164 follow-up: colliding add_comment on another server stays allow", () => {
  assert.equal(
    runGate({
      mcp_server_name: "user-linear-linear",
      tool_name: "add_comment",
      tool_input: { id: "issue-1", body: "hi" },
    }).permission,
    "allow",
  );
});

test("RAD-164 follow-up: unrecognized PR Genie MCP tool asks", () => {
  const parsed = runGate({
    mcp_server_name: "plugin-prgenie-prgenie",
    tool_name: "plugin-prgenie-prgenie-totally_unknown_tool",
    tool_input: {},
  });
  assert.equal(parsed.permission, "ask");
});

test("RAD-164: built github-gate.cjs asks for gated MCP tools on PR Genie", () => {
  for (const [tool_name, tool_input] of [
    ["export_local_pr", { id: "lp-deadbeef" }],
    ["record_export_gate_override", { id: "lp-deadbeef", who: "agent", why: "x" }],
    ["gh_use", { login: "alice" }],
    ["set_status", { id: "lp-deadbeef", status: "approved" }],
    ["set_status", { id: "lp-deadbeef", status: "reviewed" }],
    ["set_status", { id: "lp-deadbeef", status: "ready", ciSkipReason: "skip" }],
    ["add_comment", { id: "lp-deadbeef", body: "hi" }],
    ["add_comment", { id: "lp-deadbeef", body: "hi", role: "human" }],
  ] as const) {
    const parsed = runGate({
      mcp_server_name: "plugin-prgenie-prgenie",
      tool_name,
      tool_input,
    });
    assert.equal(parsed.permission, "ask", tool_name);
    assert.match(String(parsed.agent_message ?? ""), /Human-only MCP/i);
  }
});

test("RAD-164: built github-gate.cjs allows ungated MCP tools", () => {
  assert.equal(
    runGate({
      mcp_server_name: "plugin-prgenie-prgenie",
      tool_name: "get_local_pr",
      tool_input: { id: "lp-deadbeef" },
    }).permission,
    "allow",
  );
  assert.equal(
    runGate({
      mcp_server_name: "plugin-prgenie-prgenie",
      tool_name: "set_status",
      tool_input: { id: "lp-deadbeef", status: "ready" },
    }).permission,
    "allow",
  );
  assert.equal(
    runGate({
      mcp_server_name: "plugin-prgenie-prgenie",
      tool_name: "add_comment",
      tool_input: { id: "lp-deadbeef", body: "ok", role: "agent" },
    }).permission,
    "allow",
  );
  assert.equal(
    runGate({
      mcp_server_name: "plugin-prgenie-prgenie",
      tool_name: "add_comment",
      tool_input: {
        id: "lp-deadbeef",
        role: "agent",
        body: "CI skipped: no node on PATH",
      },
    }).permission,
    "ask",
  );
  assert.equal(
    runGate({
      mcp_server_name: "user-figma",
      tool_name: "export_local_pr",
      tool_input: { id: "lp-deadbeef" },
    }).permission,
    "allow",
  );
});

test("RAD-164: built github-gate.cjs asks when MCP tool_input JSON is invalid", () => {
  const parsed = runGate({
    mcp_server_name: "plugin-prgenie-prgenie",
    tool_name: "set_status",
    tool_input: "{not-json",
  });
  assert.equal(parsed.permission, "ask");
});
