import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childProcessSpawnOptions } from "./spawn-options.js";

describe("childProcessSpawnOptions", () => {
  it("always sets windowsHide", () => {
    const opts = childProcessSpawnOptions({ cwd: "/tmp" });
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.cwd, "/tmp");
  });
});
