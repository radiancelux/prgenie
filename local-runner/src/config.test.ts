import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STDIO_PLACEHOLDER_TOKEN, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults host to loopback", async () => {
    const env = { PRGENIE_RUNNER_TOKEN: "t" };
    const cfg = await loadConfig(env, { command: "serve" });
    assert.equal(cfg.host, "127.0.0.1");
  });

  it("reads PRGENIE_RUNNER_HOST", async () => {
    const env = { PRGENIE_RUNNER_TOKEN: "t", PRGENIE_RUNNER_HOST: "0.0.0.0" };
    const cfg = await loadConfig(env, { command: "serve" });
    assert.equal(cfg.host, "0.0.0.0");
  });

  it("mcp command does not require PRGENIE_RUNNER_TOKEN", async () => {
    const cfg = await loadConfig(
      { PRGENIE_RUNNER_DATA_DIR: "/tmp/prgenie-mcp-test" },
      { command: "mcp" },
    );
    assert.equal(cfg.token, STDIO_PLACEHOLDER_TOKEN);
  });

  it("serve requires bearer token", async () => {
    await assert.rejects(
      () => loadConfig({ PRGENIE_RUNNER_DATA_DIR: "/tmp/none" }, { command: "serve" }),
      /PRGENIE_RUNNER_TOKEN/,
    );
  });
});
