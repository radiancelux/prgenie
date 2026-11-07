import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseMarkdownlintFindings } from "./doc-checks.js";
import { parseJsonBody, parseJsonObject, redactSecrets, readBoundedBody } from "./http-request.js";

describe("http-request", () => {
  it("redacts bearer tokens from error strings", () => {
    const raw = "failed: Bearer super-secret-token-abcdef12";
    assert.match(redactSecrets(raw), /\[redacted\]/);
    assert.doesNotMatch(redactSecrets(raw), /super-secret-token/);
  });

  it("rejects non-object JSON for API bodies", () => {
    assert.equal(parseJsonObject("[]").ok, false);
    assert.equal(parseJsonObject("null").ok, false);
    assert.equal(parseJsonObject('{"a":1}').ok, true);
  });

  it("parseJsonBody handles partial input", () => {
    assert.equal(parseJsonBody("").ok, false);
    assert.equal(parseJsonBody("{").ok, false);
  });

  it("readBoundedBody rejects oversized payload", async () => {
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    const p = readBoundedBody(req as never, 8);
    req.emit("data", Buffer.from("123456789"));
    req.emit("end");
    const res = await p;
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 413);
  });
});

describe("parseMarkdownlintFindings", () => {
  it("parses many findings up to cap", () => {
    const lines = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`docs/a-${i}.md:${i}:1 error MD013/line-length Line too long`);
    }
    const { findings, truncated } = parseMarkdownlintFindings(lines.join("\n"));
    assert.equal(findings.length, 60);
    assert.equal(truncated, false);
    assert.equal(findings[0].rule, "MD013/line-length");
  });
});
