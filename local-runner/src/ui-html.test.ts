import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { runnerUiHtml } from "./ui-html.js";

function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

describe("runnerUiHtml inline scripts", () => {
  it("emits JavaScript that parses in vm.Script", () => {
    const html = runnerUiHtml(8765, ["http://127.0.0.1:8765/"]);
    const scripts = inlineScriptBodies(html);
    assert.ok(scripts.length >= 1, "expected at least one inline script");
    for (const [i, body] of scripts.entries()) {
      assert.doesNotThrow(() => {
        new vm.Script(body, { filename: `runner-ui-inline-${i}.js` });
      }, `inline script ${i} should parse`);
    }
  });
});
