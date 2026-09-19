import assert from "node:assert/strict";
import { test } from "node:test";
import { bundledMcpServerPath, smokeMcpHandshake } from "./mcp-smoke.js";

test("Cursor-style NDJSON initialize lists steward tools quickly (RAD-82)", async () => {
  const result = await smokeMcpHandshake(bundledMcpServerPath(), 2000);
  assert.equal(result.ready, true, `missing stderr ready line: ${result.stderr}`);
  assert.ok(result.tools.includes("steward_next"), "missing steward_next");
  assert.ok(result.tools.includes("bind_steward"), "missing bind_steward");
  assert.ok(result.elapsedMs < 2000, `tools/list smoke took ${result.elapsedMs}ms (want <2s)`);
});
