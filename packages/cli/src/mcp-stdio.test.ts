import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMcpFrame, takeMcpMessages } from "./mcp-stdio.js";

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
