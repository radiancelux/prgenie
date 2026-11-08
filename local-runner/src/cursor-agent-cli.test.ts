import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildCursorAgentSpawn,
  resolveCursorAgentBinary,
  windowsCursorAgentFallbackCandidates,
} from "./cursor-agent-cli.js";

describe("resolveCursorAgentBinary", () => {
  const exists = new Set<string>();

  function existsSync(p: string): boolean {
    return exists.has(p);
  }

  it("resolves cursor-agent.exe on win32 PATH", () => {
    exists.clear();
    const pathEnv = "C:\\Tools;C:\\Other";
    const candidate = path.join("C:\\Tools", "cursor-agent.exe");
    exists.add(candidate);
    const resolved = resolveCursorAgentBinary({
      platform: "win32",
      pathEnv,
      existsSync,
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    });
    assert.equal(resolved, candidate);
  });

  it("resolves cursor-agent.cmd on win32 PATH", () => {
    exists.clear();
    const candidate = path.join("C:\\Bin", "cursor-agent.cmd");
    exists.add(candidate);
    const resolved = resolveCursorAgentBinary({
      platform: "win32",
      pathEnv: "C:\\Bin",
      existsSync,
      env: {},
    });
    assert.equal(resolved, candidate);
  });

  it("resolves cursor-agent.ps1 on PATH when PATHEXT excludes .ps1", () => {
    exists.clear();
    const candidate = path.join("C:\\Scripts", "cursor-agent.ps1");
    exists.add(candidate);
    const resolved = resolveCursorAgentBinary({
      platform: "win32",
      pathEnv: "C:\\Scripts",
      existsSync,
      env: {},
    });
    assert.equal(resolved, candidate);
  });

  it("falls back to %LOCALAPPDATA%/cursor-agent/cursor-agent.ps1", () => {
    exists.clear();
    const local = "C:\\Users\\u\\AppData\\Local";
    const candidate = path.join(local, "cursor-agent", "cursor-agent.ps1");
    exists.add(candidate);
    const resolved = resolveCursorAgentBinary({
      platform: "win32",
      pathEnv: "C:\\Empty",
      existsSync,
      env: { LOCALAPPDATA: local },
    });
    assert.equal(resolved, candidate);
  });

  it("falls back to agent.ps1 under cursor-agent when cursor-agent.ps1 is absent", () => {
    exists.clear();
    const local = "C:\\Users\\u\\AppData\\Local";
    const candidate = path.join(local, "cursor-agent", "agent.ps1");
    exists.add(candidate);
    const resolved = resolveCursorAgentBinary({
      platform: "win32",
      pathEnv: "",
      existsSync,
      env: { LOCALAPPDATA: local },
    });
    assert.equal(resolved, candidate);
  });

  it("resolves a bare name on unix PATH", () => {
    exists.clear();
    exists.add("/usr/local/bin/cursor-agent");
    const resolved = resolveCursorAgentBinary({
      platform: "linux",
      pathEnv: "/usr/local/bin:/usr/bin",
      existsSync,
      env: {},
    });
    assert.equal(resolved, "/usr/local/bin/cursor-agent");
  });
});

describe("buildCursorAgentSpawn", () => {
  it("wraps .ps1 with powershell.exe -File and passes argv safely", () => {
    const spaced = "C:\\Program Files\\cursor-agent\\cursor-agent.ps1";
    const spec = buildCursorAgentSpawn(spaced, ["-p", "--force", "hello world"], "win32");
    assert.equal(spec.command, "powershell.exe");
    assert.deepEqual(spec.args, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      spaced,
      "-p",
      "--force",
      "hello world",
    ]);
  });

  it("spawns .exe directly on win32", () => {
    const exe = "C:\\Tools\\cursor-agent.exe";
    const spec = buildCursorAgentSpawn(exe, ["-p", "x"], "win32");
    assert.deepEqual(spec, { command: exe, args: ["-p", "x"] });
  });

  it("wraps .cmd with cmd.exe /c and passes argv safely", () => {
    const cmd = "C:\\Bin\\cursor-agent.cmd";
    const spec = buildCursorAgentSpawn(cmd, ["-p", "hello world"], "win32");
    assert.equal(spec.command, process.env.ComSpec?.trim() || "cmd.exe");
    assert.deepEqual(spec.args, ["/d", "/s", "/c", cmd, "-p", "hello world"]);
  });

  it("lists fallback candidates in install order", () => {
    const local = "C:\\L";
    assert.deepEqual(
      windowsCursorAgentFallbackCandidates({ LOCALAPPDATA: local }, "cursor-agent"),
      [
        path.join(local, "cursor-agent", "cursor-agent.ps1"),
        path.join(local, "cursor-agent", "agent.ps1"),
      ],
    );
  });
});
