import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  githubPrCreateArgs,
  quoteGhArgsForSpawn,
  quoteWindowsShellArg,
  replaceGhBodyWithFile,
  runGh,
  withGhBodyFile,
} from "./github-ops.js";

test("quoteWindowsShellArg quotes percent env tokens (RAD-129)", () => {
  // Build tokens at runtime so cmd.exe never sees %VAR% in argv of the test harness.
  const percentTemp = `%${"TEMP"}%`;
  const percentVar = `path%${"VAR"}%`;
  assert.equal(quoteWindowsShellArg(percentTemp), `"${percentTemp}"`);
  assert.equal(quoteWindowsShellArg(percentVar), `"${percentVar}"`);
  assert.equal(quoteWindowsShellArg("safe-token"), "safe-token");
});

test("quoteWindowsShellArg refuses multiline argv (RAD-129)", () => {
  assert.throws(
    () => quoteWindowsShellArg("## Why\n\nfull body"),
    /multiline argument|RAD-129|--body-file/,
  );
});

test("quoteGhArgsForSpawn quotes body-file paths with spaces on win32 only", () => {
  const args = ["pr", "create", "--title", "RAD-95 Foo Bar", "--body-file", "C:\\tmp\\body.md"];
  const quoted = quoteGhArgsForSpawn(args);
  if (process.platform === "win32") {
    assert.equal(quoted[3], `"RAD-95 Foo Bar"`);
    assert.equal(quoted[4], "--body-file");
  } else {
    assert.deepEqual(quoted, args);
  }
});

test("githubPrCreateArgs uses --body-file not --body (RAD-129)", () => {
  const args = githubPrCreateArgs({
    title: "RAD-129 fix",
    bodyFile: "C:\\tmp\\body.md",
    base: "main",
    head: "lp-abc",
  });
  assert.deepEqual(args, [
    "pr",
    "create",
    "--title",
    "RAD-129 fix",
    "--body-file",
    "C:\\tmp\\body.md",
    "--base",
    "main",
    "--head",
    "lp-abc",
  ]);
  assert.equal(args.includes("--body"), false);
});

test("replaceGhBodyWithFile swaps --body for --body-file (RAD-129)", () => {
  assert.deepEqual(replaceGhBodyWithFile(["pr", "create", "--body", "x", "--head", "h"], "f.md"), [
    "pr",
    "create",
    "--body-file",
    "f.md",
    "--head",
    "h",
  ]);
  assert.deepEqual(replaceGhBodyWithFile(["pr", "view"], "f.md"), ["pr", "view"]);
});

test("runGh rewrites --body to --body-file so full newline/percent body reaches gh (RAD-129)", async () => {
  const percentTemp = `%${"TEMP"}%`;
  const fullBody = `## Why\n\nUses ${percentTemp} and survives newlines.`;
  const mockGhDir = await mkdtemp(path.join(tmpdir(), "mock-gh-body-rewrite-"));
  const capturePath = path.join(mockGhDir, "capture.json");
  const mockGhPath = path.join(mockGhDir, "gh");
  const mockGhScript = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const bodyIdx = args.indexOf("--body-file");
const hasBodyFlag = args.includes("--body");
let bodyFromFile = null;
if (bodyIdx >= 0 && args[bodyIdx + 1]) {
  bodyFromFile = fs.readFileSync(args[bodyIdx + 1], "utf8");
}
fs.writeFileSync(
  ${JSON.stringify(capturePath)},
  JSON.stringify({ args, hasBodyFlag, bodyFromFile }),
  "utf8",
);
process.stdout.write("https://github.com/o/r/pull/1\\n");
process.exit(0);
`;
  await writeFile(mockGhPath, mockGhScript);
  await writeFile(path.join(mockGhDir, "gh.cmd"), `@echo off\r\nnode "%~dp0gh" %*\r\n`);
  if (process.platform !== "win32") {
    await chmod(mockGhPath, 0o755);
  }

  const originalPath = process.env.PATH;
  process.env.PATH = `${mockGhDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    // Call site still passes --body (exportLocalPr); runGh must rewrite before spawn.
    const result = await runGh([
      "pr",
      "create",
      "--title",
      "RAD-129",
      "--body",
      fullBody,
      "--base",
      "main",
      "--head",
      "feat/x",
    ]);
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      hasBodyFlag: boolean;
      bodyFromFile: string | null;
    };
    assert.equal(capture.hasBodyFlag, false);
    assert.ok(capture.args.includes("--body-file"));
    assert.equal(capture.args.includes("--body"), false);
    assert.equal(capture.bodyFromFile, fullBody);
    assert.match(capture.bodyFromFile ?? "", /\n/);
    assert.ok((capture.bodyFromFile ?? "").includes(percentTemp));
  } finally {
    process.env.PATH = originalPath;
    await rm(mockGhDir, { recursive: true, force: true });
  }
});

test("withGhBodyFile + runGh delivers full newline and percent body via file path (RAD-129)", async () => {
  const percentTemp = `%${"TEMP"}%`;
  const fullBody = `## Why\n\nUses ${percentTemp} and survives newlines.`;
  const mockGhDir = await mkdtemp(path.join(tmpdir(), "mock-gh-body-"));
  const capturePath = path.join(mockGhDir, "capture.json");
  const mockGhPath = path.join(mockGhDir, "gh");
  const mockGhScript = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const bodyIdx = args.indexOf("--body-file");
const bodyFlag = args.includes("--body");
let bodyFromFile = null;
if (bodyIdx >= 0 && args[bodyIdx + 1]) {
  bodyFromFile = fs.readFileSync(args[bodyIdx + 1], "utf8");
}
fs.writeFileSync(
  ${JSON.stringify(capturePath)},
  JSON.stringify({ args, bodyFlag, bodyFromFile }),
  "utf8",
);
process.stdout.write("https://github.com/o/r/pull/1\\n");
process.exit(0);
`;
  await writeFile(mockGhPath, mockGhScript);
  await writeFile(path.join(mockGhDir, "gh.cmd"), `@echo off\r\nnode "%~dp0gh" %*\r\n`);
  if (process.platform !== "win32") {
    await chmod(mockGhPath, 0o755);
  }

  const originalPath = process.env.PATH;
  process.env.PATH = `${mockGhDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    const result = await withGhBodyFile(fullBody, (bodyFile) =>
      runGh(
        githubPrCreateArgs({
          title: "RAD-129",
          bodyFile,
          base: "main",
          head: "feat/x",
        }),
      ),
    );
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      bodyFlag: boolean;
      bodyFromFile: string | null;
    };
    assert.equal(capture.bodyFlag, false);
    assert.ok(capture.args.includes("--body-file"));
    assert.equal(capture.args.includes("--body"), false);
    assert.equal(capture.bodyFromFile, fullBody);
    assert.match(capture.bodyFromFile ?? "", /\n/);
    assert.ok((capture.bodyFromFile ?? "").includes(percentTemp));
  } finally {
    process.env.PATH = originalPath;
    await rm(mockGhDir, { recursive: true, force: true });
  }
});

test("withGhBodyFile removes the temp file after success and failure (RAD-129)", async () => {
  let seenPath: string | null = null;
  await withGhBodyFile("ok", async (bodyFile) => {
    seenPath = bodyFile;
    assert.equal(await readFile(bodyFile, "utf8"), "ok");
  });
  assert.ok(seenPath);
  await assert.rejects(() => readFile(seenPath!, "utf8"));

  let failPath: string | null = null;
  await assert.rejects(
    () =>
      withGhBodyFile("boom", async (bodyFile) => {
        failPath = bodyFile;
        throw new Error("simulated");
      }),
    /simulated/,
  );
  assert.ok(failPath);
  await assert.rejects(() => readFile(failPath!, "utf8"));
});
