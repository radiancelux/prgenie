import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGhAuthStatus } from "./github.js";
import { githubPrViewArgs } from "./export.js";

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
