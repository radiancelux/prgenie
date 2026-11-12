import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhResult } from "./spawn-cmd.js";
import { restFindOpenPrForBranch, restCreateDraftPull } from "./github-rest.js";

function ghScript(script: Array<{ match: RegExp; res: GhResult }>) {
  return async (_cwd: string, args: string[]): Promise<GhResult> => {
    const joined = args.join(" ");
    for (const row of script) {
      if (row.match.test(joined)) return row.res;
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

describe("restFindOpenPrForBranch", () => {
  it("adopts an existing open PR via REST list", async () => {
    const gh = ghScript([
      {
        match: /pulls.*head=owner:feat/i,
        res: {
          code: 0,
          stdout: JSON.stringify([
            { number: 357, html_url: "https://github.com/o/r/pull/357", state: "open" },
          ]),
          stderr: "",
        },
      },
    ]);
    const pr = await restFindOpenPrForBranch("/wt", "feat/x", "owner/r", gh);
    assert.deepEqual(pr, { number: 357, url: "https://github.com/o/r/pull/357" });
  });
});

describe("restCreateDraftPull", () => {
  it("creates a draft pull via REST POST", async () => {
    const gh = ghScript([
      {
        match: /POST.*pulls/,
        res: {
          code: 0,
          stdout: JSON.stringify({ number: 9, html_url: "https://github.com/o/r/pull/9" }),
          stderr: "",
        },
      },
    ]);
    const created = await restCreateDraftPull("/wt", "feat", "title", "main", "o/r", gh);
    assert.equal(created.ok, true);
    if (created.ok) assert.equal(created.pr.number, 9);
  });
});
