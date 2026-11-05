import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseTokenUsageFromLogContent,
  parseUsageFromStreamJsonLine,
  sumTokenUsages,
} from "./usage.js";

describe("parseUsageFromStreamJsonLine", () => {
  it("reads usage on result lines", () => {
    const line = JSON.stringify({
      type: "result",
      usage: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 10 },
    });
    assert.deepEqual(parseUsageFromStreamJsonLine(line), {
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 0,
      total: 150,
    });
  });
});

describe("sumTokenUsages", () => {
  it("sums implement + review + fix runs from log content", () => {
    const log = [
      JSON.stringify({ type: "result", usage: { inputTokens: 1000, outputTokens: 200 } }),
      JSON.stringify({ type: "result", usage: { inputTokens: 500, outputTokens: 100 } }),
    ].join("\n");
    const total = parseTokenUsageFromLogContent(log);
    assert.ok(total);
    assert.equal(total.input, 1500);
    assert.equal(total.output, 300);
    assert.equal(total.total, 1800);
    assert.deepEqual(
      sumTokenUsages([
        { input: 1000, output: 200 },
        { input: 500, output: 100 },
      ]),
      { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0, total: 1800 },
    );
  });
});
