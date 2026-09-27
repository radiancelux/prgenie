import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  escapeCmdArg,
  githubPrCreateArgs,
  githubPrEditArgs,
  quoteGhArgsForSpawn,
  quoteWindowsShellArg,
  replaceGhBodyWithFile,
  resolveGhExecutable,
  runGh,
  withGhBodyFile,
} from "./github-ops.js";

const UNICODE_TITLE = "RAD-138 — ↔ · ≥ 😀";

async function writeRecorder(
  dir: string,
  capturePath: string,
): Promise<{ file: string; kind: "exe"; prefixArgs: string[] }> {
  const recorder = path.join(dir, "rec.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const bodyIdx = args.indexOf("--body-file");
let bodyFromFile = null;
let bodyFileBytes = null;
if (bodyIdx >= 0 && args[bodyIdx + 1]) {
  bodyFileBytes = fs.readFileSync(args[bodyIdx + 1]);
  bodyFromFile = bodyFileBytes.toString("utf8");
}
const titleIdx = args.indexOf("--title");
const titleArg = titleIdx >= 0 ? args[titleIdx + 1] : null;
fs.writeFileSync(
  ${JSON.stringify(capturePath)},
  JSON.stringify({
    args,
    hasBodyFlag: args.includes("--body"),
    bodyFromFile,
    bodyFileBytes: bodyFileBytes ? bodyFileBytes.toString("base64") : null,
    titleArg,
    titleBytes: titleArg ? Buffer.from(titleArg, "utf8").toString("base64") : null,
  }),
  "utf8",
);
process.stdout.write("https://github.com/o/r/pull/1\\n");
process.exit(0);
`;
  await writeFile(recorder, script);
  return { file: process.execPath, kind: "exe", prefixArgs: [recorder] };
}

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

test("replaceGhBodyWithFile swaps --body, -b, and --body= for --body-file (RAD-129 / 142-R6)", () => {
  assert.deepEqual(replaceGhBodyWithFile(["pr", "create", "--body", "x", "--head", "h"], "f.md"), [
    "pr",
    "create",
    "--body-file",
    "f.md",
    "--head",
    "h",
  ]);
  assert.deepEqual(replaceGhBodyWithFile(["pr", "create", "-b", "y"], "f2.md"), [
    "pr",
    "create",
    "--body-file",
    "f2.md",
  ]);
  assert.deepEqual(replaceGhBodyWithFile(["pr", "create", "--body=z"], "f3.md"), [
    "pr",
    "create",
    "--body-file",
    "f3.md",
  ]);
  assert.deepEqual(replaceGhBodyWithFile(["pr", "view"], "f.md"), ["pr", "view"]);
});

test("runGh rewrites --body to --body-file so full newline/percent body reaches gh (RAD-129)", async () => {
  const percentTemp = `%${"TEMP"}%`;
  const fullBody = `## Why\n\nUses ${percentTemp} and survives newlines.`;
  const mockDir = await mkdtemp(path.join(tmpdir(), "mock-gh-body-rewrite-"));
  const capturePath = path.join(mockDir, "capture.json");
  const ghExecutable = await writeRecorder(mockDir, capturePath);
  try {
    const result = await runGh(
      [
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
      ],
      { ghExecutable },
    );
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      hasBodyFlag: boolean;
      bodyFromFile: string | null;
    };
    assert.equal(capture.hasBodyFlag, false);
    assert.ok(capture.args.includes("--body-file"));
    assert.equal(capture.bodyFromFile, fullBody);
  } finally {
    await rm(mockDir, { recursive: true, force: true });
  }
});

test("withGhBodyFile + runGh delivers full newline and percent body via file path (RAD-129)", async () => {
  const percentTemp = `%${"TEMP"}%`;
  const fullBody = `## Why\n\nUses ${percentTemp} and survives newlines.`;
  const mockDir = await mkdtemp(path.join(tmpdir(), "mock-gh-body-"));
  const capturePath = path.join(mockDir, "capture.json");
  const ghExecutable = await writeRecorder(mockDir, capturePath);
  try {
    const result = await withGhBodyFile(fullBody, (bodyFile) =>
      runGh(
        githubPrCreateArgs({
          title: "RAD-129",
          bodyFile,
          base: "main",
          head: "feat/x",
        }),
        { ghExecutable },
      ),
    );
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      hasBodyFlag: boolean;
      bodyFromFile: string | null;
    };
    assert.equal(capture.hasBodyFlag, false);
    assert.equal(capture.bodyFromFile, fullBody);
  } finally {
    await rm(mockDir, { recursive: true, force: true });
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

test("RAD-142: resolveGhExecutable prefers gh.exe, then gh.cmd, then null", async () => {
  if (process.platform === "win32") {
    const root = await mkdtemp(path.join(tmpdir(), "gh-resolve-"));
    try {
      const onlyCmd = path.join(root, "a");
      await mkdir(onlyCmd, { recursive: true });
      await writeFile(path.join(onlyCmd, "gh.cmd"), "@echo off\r\n");
      assert.deepEqual(resolveGhExecutable({ PATH: onlyCmd, Path: onlyCmd }), {
        file: path.join(onlyCmd, "gh.cmd"),
        kind: "cmd",
      });

      const withExe = path.join(root, "b");
      await mkdir(withExe, { recursive: true });
      await writeFile(path.join(withExe, "gh.exe"), "stub");
      await writeFile(path.join(withExe, "gh.cmd"), "@echo off\r\n");
      assert.deepEqual(resolveGhExecutable({ PATH: `${withExe}${path.delimiter}${onlyCmd}` }), {
        file: path.join(withExe, "gh.exe"),
        kind: "exe",
      });

      assert.equal(resolveGhExecutable({ PATH: "" }), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } else {
    assert.deepEqual(resolveGhExecutable({ PATH: "/usr/bin" }), { file: "gh", kind: "exe" });
  }
});

test("RAD-142: escapeCmdArg moves percent outside quotes", () => {
  assert.equal(escapeCmdArg("pct %USERNAME% end"), '"pct ^%USERNAME^% end"');
  assert.equal(escapeCmdArg("100%"), '"100^%"');
  assert.equal(escapeCmdArg('a"b'), '"a""b"');
  assert.equal(escapeCmdArg(""), '""');
  assert.throws(() => escapeCmdArg("line\nbreak"), /multiline|--body-file/);
});

test("RAD-142: missing gh rejects with a clear error", async () => {
  const originalPath = process.env.PATH;
  const originalPath2 = process.env.Path;
  process.env.PATH = "";
  process.env.Path = "";
  try {
    await assert.rejects(() => runGh(["auth", "status"]), /gh CLI not found on PATH/);
  } finally {
    process.env.PATH = originalPath;
    if (originalPath2 !== undefined) process.env.Path = originalPath2;
    else delete process.env.Path;
  }
});

test("RAD-142: -b, --body and --body= all become --body-file", async () => {
  const mockDir = await mkdtemp(path.join(tmpdir(), "gh-body-forms-"));
  const capturePath = path.join(mockDir, "capture.json");
  const ghExecutable = await writeRecorder(mockDir, capturePath);
  const forms: { args: string[]; body: string }[] = [
    { args: ["pr", "create", "--body", "alpha"], body: "alpha" },
    { args: ["pr", "create", "-b", "beta"], body: "beta" },
    { args: ["pr", "create", "--body=gamma"], body: "gamma" },
  ];
  try {
    for (const form of forms) {
      const result = await runGh(form.args, { ghExecutable });
      assert.equal(result.code, 0, form.args.join(" "));
      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        args: string[];
        bodyFromFile: string | null;
      };
      assert.equal(capture.bodyFromFile, form.body);
      assert.ok(capture.args.includes("--body-file"));
      assert.equal(capture.args.includes("--body"), false);
      assert.equal(capture.args.includes("-b"), false);
      assert.equal(
        capture.args.some((a) => a.startsWith("--body=")),
        false,
      );
    }
  } finally {
    await rm(mockDir, { recursive: true, force: true });
  }
});

test("RAD-142: exe spawn passes %VAR% literally", async () => {
  const mockDir = await mkdtemp(path.join(tmpdir(), "gh-exe-pct-"));
  const capturePath = path.join(mockDir, "capture.json");
  const ghExecutable = await writeRecorder(mockDir, capturePath);
  const title = "pct %USERNAME% end";
  const body = "one line %PATH%";
  try {
    const result = await runGh(
      ["pr", "create", "--title", title, "-b", body, "--base", "main", "--head", "h"],
      { ghExecutable },
    );
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      bodyFromFile: string | null;
    };
    const titleAt = capture.args.indexOf("--title");
    assert.deepEqual(capture.args.slice(titleAt, titleAt + 2), ["--title", title]);
    assert.equal(capture.bodyFromFile, body);
  } finally {
    await rm(mockDir, { recursive: true, force: true });
  }
});

test("RAD-142: gh.cmd shim receives %VAR% literally (Windows)", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const mockDir = await mkdtemp(path.join(tmpdir(), "gh-cmd-shim-"));
  const capturePath = path.join(mockDir, "capture.json");
  const recorder = path.join(mockDir, "rec.cjs");
  await writeFile(
    recorder,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2) }), "utf8");
process.exit(0);
`,
  );
  await writeFile(
    path.join(mockDir, "gh.cmd"),
    `@echo off\r\n"${process.execPath.replace(/"/g, '""')}" "%~dp0rec.cjs" %*\r\n`,
  );
  const originalPath = process.env.PATH;
  process.env.PATH = mockDir;
  try {
    const result = await runGh(["pr", "create", "--title", "pct %USERNAME% end"]);
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { args: string[] };
    const titleAt = capture.args.indexOf("--title");
    assert.equal(capture.args[titleAt + 1], "pct %USERNAME% end");
  } finally {
    process.env.PATH = originalPath;
    await rm(mockDir, { recursive: true, force: true });
  }
});

test("RAD-138: non-ASCII title and body round-trip through gh argv and body file", async () => {
  const mockDir = await mkdtemp(path.join(tmpdir(), "gh-unicode-"));
  const capturePath = path.join(mockDir, "capture.json");
  const ghExecutable = await writeRecorder(mockDir, capturePath);
  const bodyText = UNICODE_TITLE;
  try {
    const result = await withGhBodyFile(bodyText, (bodyFile) =>
      runGh(
        githubPrCreateArgs({
          title: UNICODE_TITLE,
          bodyFile,
          base: "main",
          head: "feat/x",
        }),
        { ghExecutable },
      ),
    );
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      titleArg: string;
      bodyFromFile: string;
      bodyFileBytes: string;
    };
    assert.equal(capture.titleArg, UNICODE_TITLE);
    assert.equal(capture.bodyFromFile, bodyText);
    const bodyBytes = Buffer.from(capture.bodyFileBytes, "base64");
    assert.equal(bodyBytes.toString("utf8"), bodyText);
    assert.notEqual(bodyBytes[0], 0xef);
  } finally {
    await rm(mockDir, { recursive: true, force: true });
  }
});

test("RAD-138: pr edit keeps non-ASCII title and body", async () => {
  const mockDir = await mkdtemp(path.join(tmpdir(), "gh-unicode-edit-"));
  const capturePath = path.join(mockDir, "capture.json");
  const ghExecutable = await writeRecorder(mockDir, capturePath);
  const prUrl = "https://github.com/o/r/pull/9";
  try {
    const result = await withGhBodyFile(UNICODE_TITLE, (bodyFile) =>
      runGh(githubPrEditArgs({ prUrl, title: UNICODE_TITLE, bodyFile }), { ghExecutable }),
    );
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      titleArg: string;
      bodyFromFile: string;
    };
    assert.equal(capture.titleArg, UNICODE_TITLE);
    assert.equal(capture.bodyFromFile, UNICODE_TITLE);
    assert.equal(capture.args[1], "edit");
    assert.equal(capture.args[2], prUrl);
  } finally {
    await rm(mockDir, { recursive: true, force: true });
  }
});

test("RAD-138: gh.cmd shim receives non-ASCII title intact (Windows)", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const mockDir = await mkdtemp(path.join(tmpdir(), "gh-cmd-unicode-"));
  const capturePath = path.join(mockDir, "capture.json");
  const recorder = path.join(mockDir, "rec.cjs");
  await writeFile(
    recorder,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2) }), "utf8");
process.exit(0);
`,
  );
  await writeFile(
    path.join(mockDir, "gh.cmd"),
    `@echo off\r\n"${process.execPath.replace(/"/g, '""')}" "%~dp0rec.cjs" %*\r\n`,
  );
  const originalPath = process.env.PATH;
  process.env.PATH = mockDir;
  try {
    const result = await runGh(["pr", "create", "--title", UNICODE_TITLE]);
    assert.equal(result.code, 0);
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { args: string[] };
    const titleAt = capture.args.indexOf("--title");
    assert.equal(capture.args[titleAt + 1], UNICODE_TITLE);
  } finally {
    process.env.PATH = originalPath;
    await rm(mockDir, { recursive: true, force: true });
  }
});
