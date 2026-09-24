import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseGhAuthStatus } from "./github.js";
import { githubPrViewArgs } from "./export.js";
import {
  githubPrCreateArgs,
  quoteGhArgsForSpawn,
  quoteWindowsShellArg,
  runGh,
  withGhBodyFile,
} from "./github-ops.js";

test("parseGhAuthStatus reads multiple accounts and the active flag", () => {
  const text = `
github.com
  ✓ Logged in to github.com account radiancelux (keyring)
  - Active account: true
  - Git operations protocol: https

  ✓ Logged in to github.com account ccc-radiancelux (keyring)
  - Active account: false
`;
  const accounts = parseGhAuthStatus(text);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].login, "radiancelux");
  assert.equal(accounts[0].active, true);
  assert.equal(accounts[1].login, "ccc-radiancelux");
  assert.equal(accounts[1].active, false);
});

test("githubPrViewArgs uses the branch positionally, not --head", () => {
  assert.deepEqual(githubPrViewArgs("feat/widget", { json: "state" }), [
    "pr",
    "view",
    "feat/widget",
    "--json",
    "state",
  ]);
  assert.equal(githubPrViewArgs("feat/widget", { json: "state" }).includes("--head"), false);
  assert.deepEqual(githubPrViewArgs("origin/main", { json: "url", jq: ".url" }), [
    "pr",
    "view",
    "main",
    "--json",
    "url",
    "-q",
    ".url",
  ]);
});

test("quoteWindowsShellArg keeps titles with spaces as one argv (RAD-95)", () => {
  assert.equal(quoteWindowsShellArg("simple"), "simple");
  assert.equal(
    quoteWindowsShellArg("RAD-95 — Export reliability: early bind"),
    `"RAD-95 — Export reliability: early bind"`,
  );
  assert.equal(quoteWindowsShellArg(`say "hi"`), `"say ""hi"""`);
  assert.equal(quoteWindowsShellArg(""), `""`);
});

test("quoteWindowsShellArg quotes % tokens (RAD-129)", () => {
  assert.equal(quoteWindowsShellArg("%TEMP%"), `"%TEMP%"`);
  assert.equal(quoteWindowsShellArg("path%VAR%"), `"path%VAR%"`);
  assert.equal(quoteWindowsShellArg("safe-token"), "safe-token");
});

test("quoteWindowsShellArg refuses multiline argv (RAD-129)", () => {
  assert.throws(
    () => quoteWindowsShellArg("## Why\n\nfull body"),
    /multiline argument|RAD-129|--body-file/,
  );
});

test("quoteGhArgsForSpawn quotes --title values with spaces on win32 only", () => {
  const args = ["pr", "create", "--title", "RAD-95 Foo Bar", "--body-file", "C:\\tmp\\body.md"];
  const quoted = quoteGhArgsForSpawn(args);
  if (process.platform === "win32") {
    assert.equal(quoted[3], `"RAD-95 Foo Bar"`);
    assert.equal(quoted[0], "pr");
    assert.equal(quoted[2], "--title");
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

test("withGhBodyFile + runGh delivers full newline/% body via file path (RAD-129)", async () => {
  const fullBody = "## Why\n\nUses %TEMP% and survives newlines.";
  const mockGhDir = await mkdtemp(path.join(tmpdir(), "mock-gh-body-"));
  const capturePath = path.join(mockGhDir, "capture.json");
  const mockGhPath = path.join(mockGhDir, "gh");
  // Capture argv + body-file contents. Windows: gh.cmd → node so shell:true still works.
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
    assert.match(capture.bodyFromFile ?? "", /%TEMP%/);
    assert.match(capture.bodyFromFile ?? "", /\n/);
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
