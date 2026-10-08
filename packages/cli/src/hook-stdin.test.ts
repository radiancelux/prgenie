import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gateNoInputPayload,
  normalizeHookWorkspacePath,
  parseHookPayloadBuffer,
  parseHookPayloadText,
  stripUtf8BomBuffer,
} from "./hook-stdin.js";

const CURSOR_SHAPE = {
  conversation_id: "conv-1",
  mcp_server_name: "PR Genie",
  tool_name: "export_local_pr",
  tool_input: JSON.stringify({ id: "lp-deadbeef" }),
};

test("RAD-185: UTF-8 BOM + Cursor-shaped JSON parses", () => {
  const json = JSON.stringify(CURSOR_SHAPE);
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")]);
  const parsed = parseHookPayloadBuffer(raw);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.input.tool_name, "export_local_pr");
  }
  assert.equal(stripUtf8BomBuffer(raw).toString("utf8"), json);
});

test("RAD-185: empty stdin fails closed parse", () => {
  const empty = parseHookPayloadBuffer(Buffer.alloc(0));
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.match(empty.reason, /no input/i);
    assert.equal(gateNoInputPayload(empty.reason).permission, "ask");
  }
});

test("RAD-185: truncated JSON fails closed parse", () => {
  const bad = parseHookPayloadText('{"conversation_id":');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.reason, /unparseable/i);
  }
});

test("RAD-185: normalizeHookWorkspacePath accepts /c:/ roots", () => {
  if (process.platform === "win32") {
    const normalized = normalizeHookWorkspacePath("/c:/Users/foo/pr-genie");
    assert.match(normalized, /^C:[\\/]Users[\\/]foo[\\/]pr-genie$/i);
  } else {
    assert.equal(normalizeHookWorkspacePath("/c:/Users/foo"), pathLike("/c:/Users/foo"));
  }
});

function pathLike(p: string): string {
  return p;
}
