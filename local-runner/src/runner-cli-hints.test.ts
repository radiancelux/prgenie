import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unknownRunnerCommandMessage } from "./runner-cli-hints.js";

describe("unknownRunnerCommandMessage", () => {
  it("points plugin CLI commands at monorepo install", () => {
    const msg = unknownRunnerCommandMessage("list");
    assert.match(msg, /plugin\/monorepo CLI/);
    assert.match(msg, /pnpm cli list/);
  });

  it("uses generic text for other unknown commands", () => {
    assert.equal(unknownRunnerCommandMessage("not-real"), "unknown command: not-real");
  });
});
