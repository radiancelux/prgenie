import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { readLoopCancel, writeLoopCancel } from "@prgenie/core";
import { handleTool } from "./mcp.js";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-mcp-cancel-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("MCP run_ci vs loop cancel", () => {
  it("RAD-139: run_ci refuses a cancelled loop", async () => {
    const pr = (await handleTool("create_local_pr", {
      cwd: repo,
      title: "mcp cancel",
      body: "test",
      base: "main",
    })) as { id: string };
    await writeLoopCancel(repo, pr.id, {
      cancelledBy: "human",
      source: "panel",
      implementorTaskId: null,
    });
    await assert.rejects(
      () => handleTool("run_ci", { cwd: repo, id: pr.id, skipCache: true }),
      /Loop cancelled from panel at/,
    );
  });

  it("RAD-139: clear_loop_cancel lets run_ci run again", async () => {
    const pr = (await handleTool("create_local_pr", {
      cwd: repo,
      title: "mcp clear",
      body: "test",
      base: "main",
    })) as { id: string };
    await writeLoopCancel(repo, pr.id, {
      cancelledBy: "human",
      source: "panel",
      implementorTaskId: null,
    });
    const cleared = (await handleTool("clear_loop_cancel", { cwd: repo, id: pr.id })) as {
      id: string;
      cleared: boolean;
    };
    assert.equal(cleared.id, pr.id);
    assert.equal(cleared.cleared, true);
    const again = (await handleTool("clear_loop_cancel", { cwd: repo, id: pr.id })) as {
      cleared: boolean;
    };
    assert.equal(again.cleared, true);
    const result = (await handleTool("run_ci", {
      cwd: repo,
      id: pr.id,
      skipCache: true,
    })) as { selection?: { checks?: string[]; skipped?: boolean } };
    assert.ok(result.selection !== undefined);
  });

  it("RAD-139: run_ci and clear_loop_cancel resolve a loop id prefix", async () => {
    const pr = (await handleTool("create_local_pr", {
      cwd: repo,
      title: "mcp prefix",
      body: "test",
      base: "main",
    })) as { id: string };
    const prefix = pr.id.slice(0, -2);
    await writeLoopCancel(repo, pr.id, {
      cancelledBy: "human",
      source: "panel",
      implementorTaskId: null,
    });
    await assert.rejects(
      () => handleTool("run_ci", { cwd: repo, id: prefix, skipCache: true }),
      /Loop cancelled from panel at/,
    );
    const cleared = (await handleTool("clear_loop_cancel", { cwd: repo, id: prefix })) as {
      id: string;
      cleared: boolean;
    };
    assert.equal(cleared.id, pr.id);
    assert.equal(cleared.cleared, true);
    assert.equal(readLoopCancel(repo, pr.id), null);
  });

  it("RAD-139: clear_loop_cancel errors for an id that matches no loop", async () => {
    await assert.rejects(
      () => handleTool("clear_loop_cancel", { cwd: repo, id: "lp-nomatch" }),
      /Local PR not found/,
    );
  });
});
