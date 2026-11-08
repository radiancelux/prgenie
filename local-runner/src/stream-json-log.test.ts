import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentLogTail,
  formatAgentLogTailHtml,
  formatToolError,
  looksLikeStreamJsonLog,
  parseAgentLogBlocks,
  summarizeToolArgs,
  toolPayload,
  toolStepLabel,
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

  it("renders HTML transcript with prose and tool blocks", () => {
    const raw = [
      "--- agent (composer-2.5, stream-json) ---",
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will read the file."}]}}',
      '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"/repo/src/foo.ts"}}}}',
    ].join("\n");
    const html = formatAgentLogTailHtml(raw);
    assert.match(html, /agent-bubble/);
    assert.match(html, /I will read the file/);
    assert.match(html, /agent-tool-step/);
    assert.match(html, /Reading/);
    assert.match(html, /<details class="agent-tool-step"/);
    const blocks = parseAgentLogBlocks(raw);
    assert.ok(blocks && blocks.some((b) => b.kind === "prose"));
    assert.ok(blocks && blocks.some((b) => b.kind === "tool" && b.name === "read"));
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

  it("collapses thinking in HTML transcript", () => {
    const raw = [
      "--- agent (composer-2.5, stream-json) ---",
      '{"type":"thinking","subtype":"delta","text":"secret plan"}',
      '{"type":"thinking","subtype":"completed"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi."}]}}',
    ].join("\n");
    const html = formatAgentLogTailHtml(raw);
    assert.match(html, /agent-thinking-collapse/);
    assert.match(html, /secret plan/);
    assert.match(html, /agent-bubble/);
  });

  it("labels tool steps for the dashboard", () => {
    assert.equal(toolStepLabel("read"), "Reading");
    assert.equal(toolStepLabel("shell"), "Running");
  });

  it("dims tool failures that were later recovered", () => {
    const raw = [
      "--- agent (composer-2.5, stream-json) ---",
      '{"type":"tool_call","subtype":"started","tool_call":{"editToolCall":{"args":{"path":"/a.ts"}}}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"editToolCall":{"args":{"path":"/a.ts"},"result":{"error":{"modelVisibleError":"nope"}}}}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed another way."}]}}',
    ].join("\n");
    const html = formatAgentLogTailHtml(raw);
    assert.match(html, /agent-tool-failed-recovered/);
  });

  it("renders elapsed running meta on open shell tools", () => {
    const started = new Date(Date.now() - 12 * 60_000 - 40_000).toISOString();
    const raw = [
      "--- agent (stream-json) ---",
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"blender -b"}}}}',
    ].join("\n");
    const html = formatAgentLogTailHtml(raw, {
      nowMs: Date.now(),
      runningCommand: {
        summary: "blender -b",
        startedAt: started,
        processLabel: "blender (270% CPU)",
      },
    });
    assert.match(html, /agent-tool-running-meta/);
    assert.match(html, /running 12m/);
    assert.match(html, /blender \(270% CPU\)/);
  });

  it("omits running meta on an open shell without live runtime (e.g. killed job)", () => {
    const raw = [
      "--- agent (stream-json) ---",
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"blender -b"}}}}',
    ].join("\n");
    assert.doesNotMatch(formatAgentLogTailHtml(raw), /agent-tool-running-meta/);
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
