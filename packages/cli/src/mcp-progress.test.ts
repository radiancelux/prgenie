import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMcpCiPlanNotFullSuite,
  extractProgressToken,
  isMcpHeavyTool,
  isMcpProgressOptIn,
  MCP_HEAVY_TOOLS,
  MCP_HEARTBEAT_INTERVAL_MS,
  MCP_PROGRESS_ENV,
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
  assert.equal(MCP_SERVER_TIMEOUT_SEC, 2400);
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

test("RAD-128: progressToken present but progress off by default (message still works)", async () => {
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
  assert.equal(
    methods.filter((m) => m === "notifications/progress").length,
    0,
    "must not emit notifications/progress unless opt-in",
  );
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
    messages.some((m) => /started/.test(m)),
    "message channel must emit started",
  );
  assert.ok(
    messages.some((m) => /still working|lint:core/.test(m)),
    "message channel must heartbeat / report while in flight",
  );
  assert.ok(
    messages.some((m) => /done/.test(m)),
    "stop() must emit a final done on notifications/message",
  );
  assert.equal(
    methods.filter((m) => m === "notifications/progress").length,
    0,
    "stop/done must never send progress (post-settle token race)",
  );
});

test("RAD-128: opt-in progress mid-flight; stop never sends progress", async () => {
  const methods: string[] = [];
  const session = startMcpProgressSession({
    notify: (method) => methods.push(method),
    toolName: "run_ci",
    progressToken: "tok",
    enableProgress: true,
    heartbeatMs: 60_000,
  });
  assert.ok(methods.includes("notifications/progress"));
  const progressBeforeStop = methods.filter((m) => m === "notifications/progress").length;
  assert.ok(progressBeforeStop >= 1);
  session.stop();
  const progressAfterStop = methods.filter((m) => m === "notifications/progress").length;
  assert.equal(
    progressAfterStop,
    progressBeforeStop,
    "stop() must not emit notifications/progress (done is message-only)",
  );
  assert.ok(methods.filter((m) => m === "notifications/message").length >= 2);
});

test("isMcpProgressOptIn reads PRGENIE_MCP_PROGRESS", () => {
  assert.equal(isMcpProgressOptIn({}), false);
  assert.equal(isMcpProgressOptIn({ [MCP_PROGRESS_ENV]: "1" }), true);
  assert.equal(isMcpProgressOptIn({ [MCP_PROGRESS_ENV]: "true" }), true);
  assert.equal(isMcpProgressOptIn({ [MCP_PROGRESS_ENV]: "yes" }), true);
  assert.equal(isMcpProgressOptIn({ [MCP_PROGRESS_ENV]: "0" }), false);
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
