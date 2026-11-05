import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentLogTail,
  formatToolError,
  looksLikeStreamJsonLog,
  summarizeToolArgs,
  toolPayload,
} from "./stream-json-log.js";

describe("stream-json log formatting", () => {
  it("passes through non-stream-json tails unchanged", () => {
    const dry = "[dry-run] cursor-agent would run in /tmp\nhello...\n";
    assert.equal(formatAgentLogTail(dry), dry);
    assert.equal(looksLikeStreamJsonLog(dry), false);
  });

  it("renders assistant, thinking, and tool steps", () => {
    const raw = [
      "--- agent (composer-2.5, stream-json) ---",
      '{"type":"system","subtype":"init","model":"Composer 2.5"}',
      '{"type":"thinking","subtype":"delta","text":"Plan "}',
      '{"type":"thinking","subtype":"delta","text":"work"}',
      '{"type":"thinking","subtype":"completed"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done planning."}]}}',
      '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"/repo/src/foo.ts"}}}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"readToolCall":{"args":{"path":"/repo/src/foo.ts"},"result":{"success":{}}}}}',
    ].join("\n");

    const out = formatAgentLogTail(raw);
    assert.match(out, /▸ Started Composer 2\.5/);
    assert.match(out, /💭 Plan work/);
    assert.match(out, /Done planning\./);
    assert.match(out, /⚙ read — …\/src\/foo\.ts/);
  });

  it("surfaces tool failures", () => {
    const err = formatToolError({
      error: { modelVisibleError: "Invalid arguments" },
    });
    assert.equal(err, "Invalid arguments");

    const raw = [
      "--- agent (composer-2.5, stream-json) ---",
      '{"type":"tool_call","subtype":"started","tool_call":{"editToolCall":{"args":{"path":"/a/b.ts"}}}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"editToolCall":{"args":{"path":"/a/b.ts"},"result":{"error":{"modelVisibleError":"Invalid arguments"}}}}}',
    ].join("\n");
    assert.match(formatAgentLogTail(raw), /✗ edit failed: Invalid arguments/);
  });

  it("summarizes shell commands", () => {
    assert.match(
      summarizeToolArgs("shell", { command: "git status", description: "status" }),
      /git status/,
    );
    const { kind, args } = toolPayload({
      shellToolCall: { args: { command: "npm test" } },
    });
    assert.equal(kind, "shell");
    assert.equal(args.command, "npm test");
  });
});
