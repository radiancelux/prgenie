import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STDIO_PLACEHOLDER_TOKEN, loadConfig, parseRunnerPort } from "./config.js";

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

  it("rejects invalid PRGENIE_RUNNER_PORT", async () => {
    assert.throws(() => parseRunnerPort("xy"), /port number/);
    await assert.rejects(
      () =>
        loadConfig(
          { PRGENIE_RUNNER_TOKEN: "t", PRGENIE_RUNNER_PORT: "70000" },
          { command: "serve" },
        ),
      /between 1 and 65535/,
    );
  });

  it("serve requires bearer token", async () => {
    await assert.rejects(
      () => loadConfig({ PRGENIE_RUNNER_DATA_DIR: "/tmp/none" }, { command: "serve" }),
      /PRGENIE_RUNNER_TOKEN/,
    );
  });
});
