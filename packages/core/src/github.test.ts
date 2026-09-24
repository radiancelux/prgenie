import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGhAuthStatus } from "./github.js";
import { githubPrViewArgs } from "./export.js";
import { quoteGhArgsForSpawn, quoteWindowsShellArg } from "./github-ops.js";

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

test("quoteGhArgsForSpawn quotes --title values with spaces on win32 only", () => {
  const args = ["pr", "create", "--title", "RAD-95 Foo Bar", "--body", "ok"];
  const quoted = quoteGhArgsForSpawn(args);
  if (process.platform === "win32") {
    assert.equal(quoted[3], `"RAD-95 Foo Bar"`);
    assert.equal(quoted[0], "pr");
    assert.equal(quoted[2], "--title");
  } else {
    assert.deepEqual(quoted, args);
  }
});
