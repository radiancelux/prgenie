import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhResult } from "./spawn-cmd.js";
import {
  commitAllIfDirty,
  createDraftPr,
  ensureDraftPrAfterBuild,
  workingTreeDirty,
} from "./post-build-pr.js";

function gitImpl(script: Record<string, GhResult>) {
  return async (_cwd: string, args: string[]): Promise<GhResult> => {
    const key = args.join("\0");
    return (
      script[key] ?? {
        code: 1,
        stdout: "",
        stderr: `unexpected git ${args.join(" ")}`,
      }
    );
  };
}

function ghPath(args: string[]): string {
  return args.join(" ");
}

function ghRoute(match: (path: string) => boolean, res: GhResult) {
  return { match: (args: string[]) => match(ghPath(args)), res };
}

function ghImpl(routes: Array<{ match: (args: string[]) => boolean; res: GhResult }>) {
  return async (_cwd: string, args: string[]): Promise<GhResult> => {
    for (const row of routes) {
      if (row.match(args)) return row.res;
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
}

describe("post-build-pr", () => {
  it("commits, pushes, and creates draft PR", async () => {
    const git = gitImpl({
      "status\0--porcelain": { code: 0, stdout: " M README.md\n", stderr: "" },
      "add\0-A": { code: 0, stdout: "", stderr: "" },
      "commit\0-m\0feat/x": { code: 0, stdout: "", stderr: "" },
      "rev-parse\0HEAD": { code: 0, stdout: "abc\n", stderr: "" },
      "rev-parse\0refs/remotes/origin/feat/x": { code: 1, stdout: "", stderr: "" },
      "push\0-u\0origin\0feat/x": { code: 0, stdout: "", stderr: "" },
    });
    const gh = ghImpl([
      ghRoute((p) => p.includes("pulls") && p.includes("state=open"), {
        code: 0,
        stdout: "[]\n",
        stderr: "",
      }),
      ghRoute((p) => p.includes("default_branch"), { code: 0, stdout: "main\n", stderr: "" }),
      ghRoute((p) => p.includes("POST") && p.includes("pulls"), {
        code: 0,
        stdout: JSON.stringify({ number: 9, html_url: "https://github.com/o/r/pull/9" }),
        stderr: "",
      }),
    ]);
    const res = await ensureDraftPrAfterBuild(
      { cwd: "/wt", branch: "feat/x", title: "feat/x", repoSlug: "owner/r" },
      { git, gh },
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.pr.number, 9);
      assert.match(res.pr.url, /pull\/9/);
    }
  });

  it("detects dirty tree and commits", async () => {
    const git = gitImpl({
      "status\0--porcelain": { code: 0, stdout: " M x\n", stderr: "" },
      "add\0-A": { code: 0, stdout: "", stderr: "" },
      "commit\0-m\0msg": { code: 0, stdout: "", stderr: "" },
    });
    assert.equal(await workingTreeDirty("/wt", git), true);
    assert.deepEqual(await commitAllIfDirty("/wt", "msg", git), { ok: true });
  });

  it("adopts existing PR before create", async () => {
    const gh = ghImpl([
      ghRoute((p) => p.includes("pulls") && p.includes("state=open"), {
        code: 0,
        stdout: JSON.stringify([{ number: 42, html_url: "https://github.com/org/repo/pull/42" }]),
        stderr: "",
      }),
    ]);
    const res = await createDraftPr("/wt", "b", "t", gh, { repoSlug: "org/repo" });
    assert.deepEqual(res, {
      ok: true,
      pr: { url: "https://github.com/org/repo/pull/42", number: 42 },
    });
  });

  it("returns REST error text when pr create fails", async () => {
    const gh = ghImpl([
      ghRoute((p) => p.includes("pulls") && p.includes("state=open"), {
        code: 0,
        stdout: "[]",
        stderr: "",
      }),
      ghRoute((p) => p.includes("default_branch"), { code: 0, stdout: "main\n", stderr: "" }),
      ghRoute((p) => p.includes("POST") && p.includes("pulls"), {
        code: 1,
        stdout: "",
        stderr: "Validation Failed: No commits between main and b",
      }),
    ]);
    const res = await createDraftPr("/wt", "b", "t", gh, { repoSlug: "org/repo" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /No commits between/i);
  });
});
