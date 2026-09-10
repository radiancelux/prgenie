import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { arg, flag, messageArg } from "./cli.js";

test("arg reads the value after a flag name", () => {
  assert.equal(arg(["--title", "Hello", "--body", "x"], "--title"), "Hello");
  assert.equal(arg(["--title", "Hello"], "--body"), undefined);
  assert.equal(arg([], "--title"), undefined);
});

test("flag detects presence", () => {
  assert.equal(flag(["--stat", "id"], "--stat"), true);
  assert.equal(flag(["id"], "--stat"), false);
});

test("messageArg prefers --body-file over -m", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prgenie-cli-msg-"));
  try {
    const file = path.join(dir, "body.txt");
    await writeFile(file, "from-file\n", "utf8");
    assert.equal(messageArg(["-m", "from-m", "--body-file", file]), "from-file\n");
    assert.equal(messageArg(["--message", "via-long"]), "via-long");
    assert.equal(messageArg(["-m", "short"]), "short");
    assert.equal(messageArg([]), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
