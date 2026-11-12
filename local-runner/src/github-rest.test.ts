import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhResult } from "./spawn-cmd.js";
import {
  restCreateDraftPull,
  restFetchCheckRunsForRef,
  restFindOpenPrForBranch,
} from "./github-rest.js";

function ghScript(script: Array<{ match: RegExp; res: GhResult }>) {
  return async (_cwd: string, args: string[]): Promise<GhResult> => {
    const joined = args.join(" ");
    for (const row of script) {
      if (row.match.test(joined)) return row.res;
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

function isGhApiGet(args: string[]): boolean {
  const i = args.indexOf("api");
  return i >= 0 && args[i + 1] === "-X" && args[i + 2] === "GET";
}

describe("restFindOpenPrForBranch", () => {
  it("adopts an existing open PR via REST list", async () => {
    const seen: string[][] = [];
    const gh = async (_cwd: string, args: string[]): Promise<GhResult> => {
      seen.push(args);
      assert.ok(isGhApiGet(args), `expected GET list pulls, got: ${args.join(" ")}`);
      return {
        code: 0,
        stdout: JSON.stringify([
          { number: 357, html_url: "https://github.com/o/r/pull/357", state: "open" },
        ]),
        stderr: "",
      };
    };
    const pr = await restFindOpenPrForBranch("/wt", "feat/x", "owner/r", gh);
    assert.deepEqual(pr, { number: 357, url: "https://github.com/o/r/pull/357" });
    assert.equal(seen.length, 1);
    assert.match(seen[0].join(" "), /head=owner:feat\/x/);
  });
});

describe("restFetchCheckRunsForRef", () => {
  it("lists check runs with GET, not POST", async () => {
    const seen: string[][] = [];
    const gh = async (_cwd: string, args: string[]): Promise<GhResult> => {
      seen.push(args);
      assert.ok(isGhApiGet(args), `expected GET check-runs, got: ${args.join(" ")}`);
      return {
        code: 0,
        stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed" }] }),
        stderr: "",
      };
    };
    const runs = await restFetchCheckRunsForRef("/wt", "abc123", "o/r", gh);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].name, "ci");
    assert.equal(seen.length, 1);
    assert.match(seen[0].join(" "), /per_page=100/);
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

  it("adopts an existing PR when 422 message is only on stdout", async () => {
    const gh = ghScript([
      {
        match: /POST.*pulls/,
        res: {
          code: 1,
          stdout: JSON.stringify({
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                code: "custom",
                message: "A pull request already exists for owner:feat.",
              },
            ],
          }),
          stderr: "gh: Validation Failed (HTTP 422)",
        },
      },
      {
        match: /GET.*pulls.*state=open/i,
        res: {
          code: 0,
          stdout: JSON.stringify([
            { number: 357, html_url: "https://github.com/o/r/pull/357", state: "open" },
          ]),
          stderr: "",
        },
      },
    ]);
    const created = await restCreateDraftPull("/wt", "feat", "title", "main", "o/r", gh);
    assert.deepEqual(created, {
      ok: true,
      pr: { number: 357, url: "https://github.com/o/r/pull/357" },
    });
  });
});
