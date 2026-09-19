import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMcpFrame, takeCompleteJsonObject, takeMcpMessages } from "./mcp-stdio.js";

test("Content-Length frames survive a long UTF-8 comment body", () => {
  const body = `Finding: \u2014 ${"x".repeat(4000)} \`prgenie watch start\` end.`;
  const msg = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "add_comment",
      arguments: { id: "lp-test", body, role: "reviewer" },
    },
  };
  const frame = encodeMcpFrame(msg);
  const split = frame.subarray(0, 40);
  const rest = frame.subarray(40);
  assert.equal(takeMcpMessages(split).messages.length, 0);
  const decoded = takeMcpMessages(Buffer.concat([split, rest]));
  assert.equal(decoded.messages.length, 1);
  const got = decoded.messages[0] as {
    params: { arguments: { body: string } };
  };
  assert.equal(got.params.arguments.body, body);
  assert.equal(decoded.rest.length, 0);
});

test("NDJSON fallback still parses a compact JSON line", () => {
  const { messages, rest } = takeMcpMessages(
    Buffer.from('{"jsonrpc":"2.0","method":"ping"}\n', "utf8"),
  );
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { method: string }).method, "ping");
  assert.equal(rest.length, 0);
});

test("encodeMcpFrame is official NDJSON (one JSON line), not Content-Length", () => {
  const frame = encodeMcpFrame({
    jsonrpc: "2.0",
    id: 1,
    result: { serverInfo: { name: "prgenie" } },
  });
  const text = frame.toString("utf8");
  assert.equal(text.startsWith("Content-Length:"), false);
  assert.equal(text.endsWith("\n"), true);
  const parsed = JSON.parse(text.trim()) as { result: { serverInfo: { name: string } } };
  assert.equal(parsed.result.serverInfo.name, "prgenie");
  const decoded = takeMcpMessages(frame);
  assert.equal(decoded.messages.length, 1);
});

test("takeMcpMessages parses initialize with no trailing newline (RAD-82)", () => {
  const raw = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
  assert.equal(raw.includes("\n"), false);
  const { messages, rest } = takeMcpMessages(Buffer.from(raw, "utf8"));
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { method: string }).method, "initialize");
  assert.equal(rest.length, 0);
  const one = takeCompleteJsonObject(Buffer.from(raw, "utf8"));
  assert.ok(one);
  assert.equal((one.value as { id: number }).id, 1);
});

test("legacy Content-Length body without a trailing newline is not a complete NDJSON line (RAD-82 hang)", () => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), "utf8");
  const legacy = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
  const jsonStart = legacy.indexOf(0x7b);
  assert.ok(jsonStart > 0);
  assert.equal(legacy.indexOf(0x0a, jsonStart), -1);
  const asText = legacy.toString("utf8");
  assert.throws(() => JSON.parse(asText.trim()));
});
