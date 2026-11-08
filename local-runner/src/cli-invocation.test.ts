import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatInitReport, type InitResult } from "./init.js";
import { formatRunnerDoctorReport, type RunnerDoctorReport } from "./runner-doctor.js";
import { prgenieCmd, runningViaNpx } from "./cli-invocation.js";

describe("cli-invocation", () => {
  const npxEnv = {
    npm_config_user_agent: "npm/10 npx/10",
    npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js",
  };

  // Node 24 / npm 11: `npx -y prgenie@latest init` runs as `npm exec`.
  const npm11NpxEnv = {
    npm_config_user_agent: "npm/11.6.2 node/v24.11.0 linux x64 workspaces/false",
    npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    npm_command: "exec",
    npm_lifecycle_event: "npx",
  };

  // Globally installed `prgenie` launched from an npm script (`npm run …`).
  const npmRunScriptEnv = {
    npm_config_user_agent: "npm/11.6.2 node/v24.11.0 linux x64 workspaces/false",
    npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    npm_command: "run-script",
    npm_lifecycle_event: "setup",
  };

  it("detects npx via npm env", () => {
    assert.equal(runningViaNpx(npxEnv), true);
    assert.equal(runningViaNpx({}), false);
    assert.equal(prgenieCmd("doctor", npxEnv), "npx -y prgenie@latest doctor");
    assert.equal(prgenieCmd("doctor", {}), "prgenie doctor");
  });

  it("detects npx on npm 11 via npm_command / npm_lifecycle_event", () => {
    assert.equal(runningViaNpx(npm11NpxEnv), true);
    assert.equal(runningViaNpx({ npm_command: "exec" }), true);
    assert.equal(runningViaNpx({ npm_command: "npx" }), true);
    assert.equal(runningViaNpx({ npm_lifecycle_event: "npx" }), true);
  });

  it("does not treat a global prgenie run as npx", () => {
    assert.equal(runningViaNpx({ PATH: "/usr/local/bin:/usr/bin", HOME: "/home/u" }), false);
    assert.equal(runningViaNpx(npmRunScriptEnv), false);
    assert.equal(prgenieCmd("doctor", npmRunScriptEnv), "prgenie doctor");
  });

  it("init next-step uses global prgenie doctor when not via npx", () => {
    const result: InitResult = {
      dataDir: "/tmp/data",
      tokenFile: "/tmp/data/runner.token",
      createdToken: true,
    };
    const report = formatInitReport(result, {});
    assert.match(report, /Next: prgenie doctor/);
    assert.doesNotMatch(report, /npx -y prgenie@latest doctor/);
  });

  it("init next-step uses npx when launched via npx", () => {
    const result: InitResult = {
      dataDir: "/tmp/data",
      tokenFile: "/tmp/data/runner.token",
      createdToken: true,
    };
    const report = formatInitReport(result, npxEnv);
    assert.match(report, /Next: npx -y prgenie@latest doctor/);
    assert.match(report, /npx -y prgenie@latest serve/);
  });

  it("init next-step uses npx on Node 24 / npm 11 npx", () => {
    const result: InitResult = {
      dataDir: "/tmp/data",
      tokenFile: "/tmp/data/runner.token",
      createdToken: true,
    };
    const report = formatInitReport(result, npm11NpxEnv);
    assert.match(report, /Next: npx -y prgenie@latest doctor/);
    assert.doesNotMatch(report, /Next: prgenie doctor/);
  });

  it("doctor fix lines use npx when launched via npx", () => {
    const report: RunnerDoctorReport = {
      ok: true,
      checks: [
        {
          id: "runner-data-dir",
          ok: true,
          severity: "warn",
          summary: "missing",
          fix: "Run `prgenie init` before `prgenie serve` (not required for stdio MCP).",
        },
      ],
    };
    const text = formatRunnerDoctorReport(report, npxEnv);
    assert.match(text, /npx -y prgenie@latest init/);
    assert.match(text, /npx -y prgenie@latest serve/);
  });
});
