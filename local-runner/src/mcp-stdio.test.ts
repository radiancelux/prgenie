import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMcpFrame, takeMcpMessages } from "./mcp-stdio.js";

test("NDJSON encode/decode round trip", () => {
  const msg = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const frame = encodeMcpFrame(msg);
  assert.equal(frame.toString("utf8").endsWith("\n"), true);
  const { messages, rest } = takeMcpMessages(frame);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], msg);
  assert.equal(rest.length, 0);
});

test("malformed line is skipped without throwing", () => {
  const buf = Buffer.from('{not-json}\n{"jsonrpc":"2.0","method":"ping"}\n', "utf8");
  const { messages, rest } = takeMcpMessages(buf);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { method: string }).method, "ping");
  assert.equal(rest.length, 0);
});

test("Content-Length framed initialize is accepted", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  const buf = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "ascii");
  const { messages } = takeMcpMessages(buf);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { method: string }).method, "initialize");
});

test("partial buffer waits for more data", () => {
  const line = '{"jsonrpc":"2.0","id":2,"method":"ping"}\n';
  const half = Buffer.from(line.slice(0, 20), "utf8");
  assert.equal(takeMcpMessages(half).messages.length, 0);
  const { messages } = takeMcpMessages(Buffer.concat([half, Buffer.from(line.slice(20), "utf8")]));
  assert.equal(messages.length, 1);
});
