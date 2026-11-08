import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cursorAgentMustNotPassPromptInArgv,
  planCursorAgentSpawn,
} from "./agent-prompt-delivery.js";

describe("agent prompt delivery (win32)", () => {
  const ps1 = "C:\\Users\\u\\AppData\\Local\\cursor-agent\\cursor-agent.ps1";
  const prompt = [
    "line one",
    "quotes \"double\" and 'single'",
    "dollar $VAR and backtick `cmd`",
    "non-ASCII: cafe",
  ].join("\n");

  it("hands full prompt on stdin, not argv, for .ps1 on win32", () => {
    assert.equal(cursorAgentMustNotPassPromptInArgv("win32", ps1, prompt), true);
    const planned = planCursorAgentSpawn(ps1, "composer-2.5", "stream-json", prompt, "win32");
    assert.equal(planned.command, "powershell.exe");
    assert.equal(planned.stdin, prompt);
    assert.ok(planned.args.includes("-File"));
    assert.equal(planned.args[planned.args.indexOf("-File") + 1], ps1);
    assert.deepEqual(
      planned.args.filter((a) => a.includes("line one") || a.includes("$VAR")),
      [],
    );
    assert.ok(planned.args.includes("stream-json"));
    assert.ok(!/\n/.test(planned.args.join(" ")));
  });

  it("uses argv for single-line prompts on unix .exe", () => {
    const exe = "/usr/bin/cursor-agent";
    const oneLine = "Do one thing";
    assert.equal(cursorAgentMustNotPassPromptInArgv("linux", exe, oneLine), false);
    const planned = planCursorAgentSpawn(exe, "m", "stream-json", oneLine, "linux");
    assert.equal(planned.stdin, undefined);
    assert.equal(planned.args.at(-1), oneLine);
  });

  it("uses stdin for multi-line prompts on unix", () => {
    const exe = "/usr/bin/cursor-agent";
    assert.equal(cursorAgentMustNotPassPromptInArgv("linux", exe, prompt), true);
    const planned = planCursorAgentSpawn(exe, "m", "stream-json", prompt, "linux");
    assert.equal(planned.stdin, prompt);
    assert.ok(!planned.args.some((a) => a.includes("line one")));
  });
});
