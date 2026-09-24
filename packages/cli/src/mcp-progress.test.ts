import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMcpCiPlanNotFullSuite,
  extractProgressToken,
  isMcpHeavyTool,
  MCP_HEAVY_TOOLS,
  MCP_HEARTBEAT_INTERVAL_MS,
  MCP_SERVER_TIMEOUT_SEC,
  RECOMMENDED_MAX_PARALLEL_IMPLEMENTOR_TASKS,
  startMcpProgressSession,
  withMcpProgress,
} from "./mcp-progress.js";

test("RAD-100: heavy tools include the five timeout offenders + CI siblings", () => {
  for (const name of [
    "list_local_prs",
    "get_local_pr",
    "run_ci",
    "export_local_pr",
    "gh_status",
    "shepherd_status",
    "steward_next",
  ]) {
    assert.equal(isMcpHeavyTool(name), true, name);
  }
  assert.equal(isMcpHeavyTool("add_comment"), false);
  assert.ok(MCP_HEAVY_TOOLS.size >= 5);
  assert.equal(MCP_SERVER_TIMEOUT_SEC, 1200);
  assert.ok(MCP_HEARTBEAT_INTERVAL_MS >= 5_000);
  assert.equal(RECOMMENDED_MAX_PARALLEL_IMPLEMENTOR_TASKS, 2);
});

test("extractProgressToken reads _meta.progressToken", () => {
  assert.equal(extractProgressToken({}), undefined);
  assert.equal(extractProgressToken({ _meta: { progressToken: "t1" } }), "t1");
  assert.equal(extractProgressToken({ _meta: { progressToken: 7 } }), 7);
});

test("assertMcpCiPlanNotFullSuite refuses DEFAULT_CI_CHECKS without scoped stamp", () => {
  assert.throws(
    () =>
      assertMcpCiPlanNotFullSuite({
        checks: ["format:check", "lint", "typecheck", "test", "build"],
        reason: ["uncertain → full suite"],
      }),
    /RAD-100|RAD-119|full-suite/,
  );
  assert.doesNotThrow(() =>
    assertMcpCiPlanNotFullSuite({
      checks: ["format:check", "lint:core", "typecheck:core", "test:core"],
      reason: ["packages/core → scoped"],
    }),
  );
});

test("startMcpProgressSession heartbeats and progress notifications", async () => {
  const methods: string[] = [];
  const messages: string[] = [];
  let fakeNow = 1_000;
  const session = startMcpProgressSession({
    notify: (method, params) => {
      methods.push(method);
      if (params && typeof params.message === "string") messages.push(params.message);
      if (params && typeof params.data === "string") messages.push(params.data);
    },
    toolName: "run_ci",
    progressToken: "tok",
    heartbeatMs: 20,
    now: () => fakeNow,
  });
  assert.ok(methods.includes("notifications/message"));
  assert.ok(methods.includes("notifications/progress"));
  fakeNow += 25;
  await new Promise((r) => setTimeout(r, 40));
  session.onCiProgress({
    phase: "ci",
    check: "lint:core",
    state: "start",
    command: "pnpm exec eslint",
  });
  session.stop();
  assert.ok(messages.some((m) => /run_ci/.test(m)));
  assert.ok(
    messages.some((m) => /done/.test(m)),
    "stop() must emit a final done tick while stopped is still false",
  );
  assert.ok(methods.filter((m) => m === "notifications/progress").length >= 2);
});

test("withMcpProgress always stops the session", async () => {
  const methods: string[] = [];
  await assert.rejects(
    () =>
      withMcpProgress(
        {
          notify: (method) => methods.push(method),
          toolName: "list_local_prs",
          heartbeatMs: 60_000,
        },
        async () => {
          throw new Error("boom");
        },
      ),
    /boom/,
  );
  assert.ok(methods.includes("notifications/message"));
  assert.ok(methods.some((m) => m === "notifications/message"));
});
