import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

  it("rejects Node below 22 with an install hint", () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, PRGENIE_TEST_NODE_VERSION: "v20.11.1" },
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "PR Genie requires Node.js 22+ (current: v20.11.1).\nInstall Node 22 (see .nvmrc) and retry.\n",
    );
  });
});
