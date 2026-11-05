import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnCommand } from "./spawn-cmd.js";

describe("spawnCommand", () => {
  it("resolves code 1 on ENOENT instead of rejecting", async () => {
    const res = await spawnCommand("__prgenie_missing_executable__", "/tmp", ["--help"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /ENOENT|not found/i);
  });
});
