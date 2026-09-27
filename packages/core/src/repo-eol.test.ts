import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("RAD-156: .gitattributes starts with * text=auto eol=lf", () => {
  const lines = readFileSync(path.join(repoRoot, ".gitattributes"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.equal(lines[0], "* text=auto eol=lf");
});

test("RAD-156: git index has no CRLF text files", () => {
  const out = execFileSync("git", ["ls-files", "--eol"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indexEol = line.split(/\s+/)[0];
    assert.notEqual(indexEol, "i/crlf", `index must not store CRLF: ${line}`);
    assert.notEqual(indexEol, "i/mixed", `index must not store mixed EOL: ${line}`);
  }
});
