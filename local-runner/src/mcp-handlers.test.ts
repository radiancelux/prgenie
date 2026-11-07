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
      promptFile: undefined,
      reviewPromptFile: undefined,
      fixPromptFile: undefined,
      maxRounds: undefined,
      model: undefined,
      driver: undefined,
      dryRun: undefined,
      ticketUrl: undefined,
      linearIssue: undefined,
      repoPath: undefined,
      remote: undefined,
      jobType: "docs",
      docsTemplate: "policy",
      title: undefined,
      stageModels: undefined,
    });
  });
});
