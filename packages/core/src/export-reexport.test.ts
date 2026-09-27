import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { exportLocalPr } from "./export.js";
import { git } from "./git.js";
import {
  createLocalPr,
  getLocalPr,
  reopenLocalPr,
  setLocalPrExportGate,
  setLocalPrStatus,
  updateLocalPr,
} from "./prs.js";
import { consoleDir } from "./store.js";
import { createTempGitRepo } from "./test-git-fixture.js";

const PR_URL = "https://github.com/o/r/pull/12";

async function bindTester(repo: string): Promise<void> {
  const dir = await consoleDir(repo);
  await writeFile(
    path.join(dir, "github.json"),
    JSON.stringify({ host: "github.com", login: "tester" }),
  );
}

async function markGateReady(repo: string, id: string): Promise<void> {
  await setLocalPrStatus(repo, id, "reviewed");
  const pr = await getLocalPr(repo, id);
  await setLocalPrExportGate(repo, id, {
    status: "ready",
    reasons: [],
    headSha: pr.headSha,
    evaluatedAt: new Date().toISOString(),
  });
}

describe("re-export updates a multiline body (RAD-150)", () => {
  it("second export calls gh pr edit --title --body-file with the new body", async () => {
    const repo = await createTempGitRepo({ prefix: "prgenie-reexport-" });
    const bare = await mkdtemp(path.join(tmpdir(), "prgenie-reexport-origin-"));
    const mockGhDir = await mkdtemp(path.join(tmpdir(), "prgenie-reexport-gh-"));
    const capturePath = path.join(mockGhDir, "capture.jsonl");
    const createdFlag = path.join(mockGhDir, "created");
    const mockGhPath = path.join(mockGhDir, "gh");
    const mockGhScript = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const bodyIdx = args.indexOf("--body-file");
let bodyFromFile = null;
if (bodyIdx >= 0 && args[bodyIdx + 1]) {
  bodyFromFile = fs.readFileSync(args[bodyIdx + 1], "utf8");
}
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, bodyFromFile }) + "\\n");
if (args[0] === "auth") {
  process.stdout.write("github.com\\n  Logged in to github.com account tester (keyring)\\n  - Active account: true\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  if (!fs.existsSync(${JSON.stringify(createdFlag)})) {
    process.stderr.write("no pull requests found\\n");
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(PR_URL)} + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  fs.writeFileSync(${JSON.stringify(createdFlag)}, "1");
  process.stdout.write(${JSON.stringify(PR_URL)} + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") {
  process.stdout.write(${JSON.stringify(PR_URL)} + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh " + args.join(" ") + "\\n");
process.exit(1);
`;
    await writeFile(mockGhPath, mockGhScript);
    if (process.platform === "win32") {
      await writeFile(
        path.join(mockGhDir, "gh.cmd"),
        `@echo off\r\n"${process.execPath.replace(/"/g, '""')}" "%~dp0gh" %*\r\n`,
      );
    }
    if (process.platform !== "win32") await chmod(mockGhPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH =
      process.platform === "win32"
        ? mockGhDir
        : `${mockGhDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      await git(bare, ["init", "--bare"]);
      await git(repo, ["remote", "add", "origin", bare]);
      await git(repo, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repo, "test.txt"), "x\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "feat"]);
      await bindTester(repo);
      const created = await createLocalPr(repo, {
        title: "Re-export title",
        body: "First body",
        base: "main",
      });
      await markGateReady(repo, created.id);
      const first = await exportLocalPr(repo, created.id);
      assert.equal(first.url, PR_URL);
      assert.equal(first.alreadyExisted, false);

      const multiline = "Line one of the new body\n\nLine two stays intact.";
      await reopenLocalPr(repo, created.id);
      await updateLocalPr(repo, created.id, { body: multiline });
      await markGateReady(repo, created.id);
      const second = await exportLocalPr(repo, created.id);
      assert.equal(second.alreadyExisted, true);
      assert.equal(second.bodyUpdated, true);

      const captures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; bodyFromFile: string | null });
      const edits = captures.filter((row) => row.args[0] === "pr" && row.args[1] === "edit");
      assert.equal(edits.length, 1);
      const edit = edits[0];
      assert.ok(edit);
      assert.equal(edit.args[2], PR_URL);
      const titleAt = edit.args.indexOf("--title");
      const bodyAt = edit.args.indexOf("--body-file");
      assert.ok(titleAt > 2);
      assert.equal(edit.args[titleAt + 1], "Re-export title");
      assert.ok(bodyAt > titleAt);
      assert.equal(edit.bodyFromFile, multiline);
      assert.match(edit.bodyFromFile ?? "", /\n\n/);
    } finally {
      process.env.PATH = originalPath;
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
      await rm(bare, { recursive: true, force: true }).catch(() => undefined);
      await rm(mockGhDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
