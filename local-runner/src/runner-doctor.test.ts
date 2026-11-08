import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { formatCursorAgentInstallFix } from "./cursor-agent-cli.js";
import {
  formatRunnerDoctorReport,
  parseGhAuthStatus,
  runRunnerDoctor,
  type GhExecResult,
} from "./runner-doctor.js";
import { runInit } from "./init.js";

describe("checkAgentCli fix text", () => {
  it("includes per-OS Cursor CLI install commands", () => {
    assert.match(formatCursorAgentInstallFix("win32"), /install\?win32=true/);
    assert.match(formatCursorAgentInstallFix("win32"), /Git for Windows/);
    assert.match(formatCursorAgentInstallFix("darwin"), /curl https:\/\/cursor.com\/install/);
    assert.match(formatCursorAgentInstallFix("linux"), /cursor-agent login/);
  });
});

describe("parseGhAuthStatus", () => {
  it("detects logged-in, not logged in, and invalid GH_TOKEN", () => {
    assert.equal(
      parseGhAuthStatus({
        code: 0,
        stdout: "Logged in to github.com as you",
        stderr: "",
      }).ok,
      true,
    );
    const notLogged = parseGhAuthStatus({
      code: 1,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    });
    assert.equal(notLogged.ok, false);
    assert.match(notLogged.summary, /not logged in/);

    const bad = parseGhAuthStatus({
      code: 1,
      stdout: "",
      stderr: "The token in GH_TOKEN is invalid.",
    });
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /GH_TOKEN/);
    assert.match(bad.fix ?? "", /unset GH_TOKEN/);
  });
});

describe("prgenie doctor", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "prgenie-runner-doc-"));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports node version and runner config after init", async () => {
    const dataDir = path.join(dir, "runner");
    await runInit({ dataDir });
    const report = await runRunnerDoctor(
      {
        ...process.env,
        PRGENIE_RUNNER_DATA_DIR: dataDir,
      },
      {
        execGh: async () => ({ code: 0, stdout: "Logged in to github.com", stderr: "" }),
        fetch: async () => new Response(null, { status: 200 }),
        checkNpmRegistry: false,
        checkAgentCli: async () => ({ id: "agent-cli", ok: true, summary: "stub" }),
      },
    );
    const node = report.checks.find((c) => c.id === "node-version");
    assert.ok(node);
    const cfg = report.checks.find((c) => c.id === "runner-config");
    assert.ok(cfg?.ok);
    assert.match(formatRunnerDoctorReport(report), /runner-data-dir/);
  });

  it("exits ok with warn when data dir is missing (stdio-only)", async () => {
    const missing = path.join(dir, "no-init-dir");
    const report = await runRunnerDoctor(
      {
        ...process.env,
        PRGENIE_RUNNER_DATA_DIR: missing,
        PRGENIE_RUNNER_TOKEN: "",
      },
      {
        execGh: async () => ({
          code: 0,
          stdout: "Logged in to github.com",
          stderr: "",
        }),
        fetch: async () => new Response(null, { status: 200 }),
        checkNpmRegistry: false,
        checkAgentCli: async () => ({
          id: "agent-cli",
          ok: true,
          summary: "cursor-agent stub",
        }),
      },
    );
    const data = report.checks.find((c) => c.id === "runner-data-dir");
    assert.equal(data?.severity, "warn");
    assert.equal(data?.ok, true);
    assert.equal(report.ok, true);
  });

  it("covers gh states via stubbed gh", async () => {
    const cases: { name: string; gh: GhExecResult; expectOk: boolean; match: RegExp }[] = [
      {
        name: "not logged in",
        gh: {
          code: 1,
          stderr: "You are not logged into any GitHub hosts.",
          stdout: "",
        },
        expectOk: false,
        match: /not logged in/,
      },
      {
        name: "invalid GH_TOKEN",
        gh: {
          code: 1,
          stderr: "The token in GH_TOKEN is invalid.",
          stdout: "",
        },
        expectOk: false,
        match: /GH_TOKEN/,
      },
      {
        name: "gh missing",
        gh: { code: 1, stderr: "", stdout: "" },
        expectOk: false,
        match: /./,
      },
    ];

    for (const c of cases.slice(0, 2)) {
      const report = await runRunnerDoctor(process.env, {
        execGh: async () => c.gh,
        fetch: async () => new Response(null, { status: 200 }),
        checkNpmRegistry: false,
      });
      const gh = report.checks.find((x) => x.id === "gh-auth");
      assert.ok(gh);
      assert.equal(gh.ok, c.expectOk);
      assert.match(gh.summary, c.match);
    }

    const noGh = await runRunnerDoctor(process.env, {
      execGh: async () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
      fetch: async () => new Response(null, { status: 200 }),
      checkNpmRegistry: false,
    });
    assert.match(noGh.checks.find((c) => c.id === "gh-auth")?.summary ?? "", /not on PATH/);
  });

  it("warns when network is unreachable", async () => {
    const report = await runRunnerDoctor(process.env, {
      execGh: async () => ({ code: 0, stdout: "Logged in", stderr: "" }),
      fetch: async () => {
        throw new Error("offline");
      },
      checkNpmRegistry: false,
    });
    const net = report.checks.find((c) => c.id === "network");
    assert.equal(net?.severity, "warn");
    assert.match(net?.summary ?? "", /unreachable/);
  });
});
