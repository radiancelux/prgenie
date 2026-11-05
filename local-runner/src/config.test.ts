import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults host to loopback", async () => {
    const env = { PRGENIE_RUNNER_TOKEN: "t" };
    const cfg = await loadConfig(env);
    assert.equal(cfg.host, "127.0.0.1");
  });

  it("reads PRGENIE_RUNNER_HOST", async () => {
    const env = { PRGENIE_RUNNER_TOKEN: "t", PRGENIE_RUNNER_HOST: "0.0.0.0" };
    const cfg = await loadConfig(env);
    assert.equal(cfg.host, "0.0.0.0");
  });
});
