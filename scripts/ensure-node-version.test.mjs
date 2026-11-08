import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "ensure-node-version.mjs");

describe("ensure-node-version", () => {
  it("passes on Node 22+", () => {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [script], { stdio: "pipe" });
    });
  });
});
