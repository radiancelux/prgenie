import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRunnerPort } from "./config.js";
import { printCliError } from "./cli-errors.js";
import { runnerCliVersion } from "./version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runnerTs = path.join(repoRoot, "local-runner/src/bin.ts");

function runRunner(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runnerTs, ...args], {
      env: { ...env },
      cwd: repoRoot,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("parseRunnerPort", () => {
  it("rejects non-numeric and out-of-range values", () => {
    assert.throws(() => parseRunnerPort("abc"), /must be a port number/);
    assert.throws(() => parseRunnerPort("0"), /between 1 and 65535/);
    assert.throws(() => parseRunnerPort("99999"), /between 1 and 65535/);
    assert.equal(parseRunnerPort("19473"), 19_473);
    assert.equal(parseRunnerPort(undefined), 9473);
  });
});

describe("printCliError", () => {
  it("prints prgenie: prefix without stack by default", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      printCliError(new Error("PRGENIE_RUNNER_TOKEN is required for serve"));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^prgenie: PRGENIE_RUNNER_TOKEN/);
      assert.doesNotMatch(lines.join("\n"), /at /);
    } finally {
      console.error = orig;
    }
  });
});

describe("runner CLI flags", () => {
  it("--version prints package version and exits 0", async () => {
    const { code, stdout } = await runRunner(["--version"]);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), runnerCliVersion());
  });

  it("--help and bare prgenie exit 0", async () => {
    assert.equal((await runRunner(["--help"])).code, 0);
    assert.equal((await runRunner([])).code, 0);
    assert.match((await runRunner(["--help"])).stdout, /prgenie serve/);
  });

  it("unknown command exits non-zero", async () => {
    const { code, stderr } = await runRunner(["not-a-command"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /prgenie: unknown command/);
    assert.doesNotMatch(stderr, /at /);
  });

  it("plugin CLI command names get a targeted hint", async () => {
    const { code, stderr } = await runRunner(["list"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /plugin\/monorepo CLI/);
  });

  it("unknown --client exits non-zero", async () => {
    const { code, stderr } = await runRunner(["config", "--client", "typo"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown --client typo/);
  });

  it("config --client claude-desktop prints JSON", async () => {
    const { code, stdout } = await runRunner(["config", "--client", "claude-desktop", "--npx"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout) as { mcpServers: Record<string, unknown> };
    assert.ok(parsed.mcpServers["prgenie-runner"]);
  });
});

describe("serve startup errors", () => {
  it("missing token exits with readable message (no stack)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "prgenie-serve-home-"));
    const { code, stderr } = await runRunner(["serve"], {
      ...process.env,
      HOME: home,
      PRGENIE_RUNNER_DATA_DIR: path.join(home, "data"),
      PRGENIE_RUNNER_PORT: "29473",
      PRGENIE_RUNNER_TOKEN: "",
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /prgenie:.*PRGENIE_RUNNER_TOKEN/);
    assert.doesNotMatch(stderr, /at loadConfig/);
  });

  it("invalid port is rejected before listen", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "prgenie-serve-port-"));
    const dataDir = path.join(home, "data");
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
    await wf(path.join(dataDir, "runner.token"), "secret\n");

    const { code, stderr } = await runRunner(["serve"], {
      ...process.env,
      HOME: home,
      PRGENIE_RUNNER_DATA_DIR: dataDir,
      PRGENIE_RUNNER_PORT: "not-a-port",
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /PRGENIE_RUNNER_PORT must be a port number/);
  });

  it("EADDRINUSE prints one line after bind failure", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "prgenie-serve-busy-"));
    const dataDir = path.join(home, "data");
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
    await wf(path.join(dataDir, "runner.token"), "secret\n");

    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;

    const child = spawn(process.execPath, ["--import", "tsx", runnerTs, "serve"], {
      env: {
        ...process.env,
        HOME: home,
        PRGENIE_RUNNER_DATA_DIR: dataDir,
        PRGENIE_RUNNER_PORT: String(port),
        PRGENIE_RUNNER_TOKEN: "secret",
      },
      cwd: repoRoot,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });
    await new Promise<void>((r) => blocker.close(() => r()));

    assert.notEqual(code, 0);
    assert.doesNotMatch(stdout, /listening on/);
    assert.match(stderr, /prgenie: Port .* already in use/);
    assert.doesNotMatch(stderr, /at Server\./);
  });
});
