import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleRunnerTool, RUNNER_MCP_TOOLS } from "./mcp-handlers.js";
import type { RunnerEngine } from "./engine.js";
import type { JobRecord } from "./types.js";

describe("continue_job MCP schema", () => {
  it("lists required id and optional continue fields", () => {
    const tool = RUNNER_MCP_TOOLS.find((t) => t.name === "continue_job");
    assert.ok(tool);
    assert.deepEqual(tool!.inputSchema.required, ["id"]);
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    assert.ok(props.prompt && props.extraRounds && props.model);
  });
});

describe("start_job MCP schema", () => {
  it("includes docs job type and template fields", () => {
    const tool = RUNNER_MCP_TOOLS.find((t) => t.name === "start_job");
    assert.ok(tool);
    const props = tool!.inputSchema.properties as Record<string, unknown>;
    assert.ok(props.jobType);
    assert.ok(props.profile);
    assert.ok(props.docsTemplate);
    assert.ok(props.title);
    assert.ok(props.expectPr);
  });

  it("lists settings tool for maintainable registry", () => {
    assert.ok(RUNNER_MCP_TOOLS.some((t) => t.name === "settings"));
  });

  it("advertises per-stage models so MCP clients can send an explicit fix model", () => {
    const tool = RUNNER_MCP_TOOLS.find((t) => t.name === "start_job");
    const props = tool!.inputSchema.properties as Record<
      string,
      { type: string; properties?: Record<string, unknown> }
    >;
    assert.equal(props.stageModels.type, "object");
    assert.deepEqual(Object.keys(props.stageModels.properties ?? {}), ["build", "review", "fix"]);
  });

  it("uses operator-neutral ticket field descriptions", () => {
    const tool = RUNNER_MCP_TOOLS.find((t) => t.name === "start_job");
    const props = tool!.inputSchema.properties as Record<string, { description?: string }>;
    assert.match(String(props.ticketUrl.description), /issue-<n>/);
    assert.doesNotMatch(String(props.ticketUrl.description), /RAD-n/);
    assert.match(String(props.linearIssue.description), /ISSUE-/);
  });
});

describe("start_job validation", () => {
  it("passes docs args to engine", async () => {
    let captured: unknown;
    const engine = {
      startJob: async (args: unknown) => {
        captured = args;
        return { id: "x" } as JobRecord;
      },
    } as unknown as RunnerEngine;

    await handleRunnerTool(engine, "start_job", {
      branch: "docs/foo",
      jobType: "docs",
      docsTemplate: "policy",
    });
    assert.deepEqual(captured, {
      branch: "docs/foo",
      jobType: "docs",
      docsTemplate: "policy",
    });
  });
});
