import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { handleTool, tools } from "./mcp.js";
import type { LocalPr } from "@prgenie/core";

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-mcp-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feat/mcp-tools"]);
  await writeFile(path.join(repo, "tool.txt"), "v1\n");
  git(["add", "."]);
  git(["commit", "-m", "add tool"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("tools catalog exposes core flywheel tools", () => {
  const names = new Set(tools.map((t) => t.name));
  for (const required of [
    "create_local_pr",
    "list_local_prs",
    "get_local_pr",
    "set_status",
    "add_comment",
    "complete_review",
    "get_diff",
    "watch_status",
    "list_sessions",
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
  assert.ok(tools.every((t) => t.inputSchema && typeof t.inputSchema === "object"));
});

test("handleTool create/list/get/set_status/add_comment/get_diff", async () => {
  const created = (await handleTool("create_local_pr", {
    cwd: repo,
    title: "MCP tool coverage",
    body: "Exercise handleTool layer.",
    base: "main",
  })) as LocalPr;
  assert.match(created.id, /^lp-[0-9a-f]{8}$/);
  assert.equal(created.status, "draft");

  const listed = (await handleTool("list_local_prs", {
    cwd: repo,
    search: "MCP tool",
    in: "title",
  })) as LocalPr[];
  assert.ok(listed.some((p) => p.id === created.id));

  await handleTool("set_status", { cwd: repo, id: created.id, status: "ready" });
  const got = (await handleTool("get_local_pr", { cwd: repo, id: created.id })) as LocalPr & {
    pendingComments: unknown[];
  };
  assert.equal(got.status, "ready");
  assert.ok(Array.isArray(got.pendingComments));

  const withFinding = (await handleTool("add_comment", {
    cwd: repo,
    id: created.id,
    body: "Please rename tool.txt",
    role: "reviewer",
    path: "tool.txt",
    line: 1,
  })) as LocalPr;
  assert.ok(withFinding.comments.some((c) => c.body.includes("rename")));

  const diff = (await handleTool("get_diff", {
    cwd: repo,
    id: created.id,
    stat: true,
  })) as { files: unknown; diff: string };
  assert.match(diff.diff, /tool\.txt/);
});

test("handleTool watch_status and unknown tool", async () => {
  const watch = (await handleTool("watch_status", { cwd: repo })) as {
    inbox: { halted: boolean };
    queue: { halted: boolean };
  };
  assert.equal(typeof watch.inbox.halted, "boolean");
  assert.equal(typeof watch.queue.halted, "boolean");

  await assert.rejects(() => handleTool("not_a_real_tool", { cwd: repo }), /Unknown tool/);
});

test("handleTool list_local_prs status filter and complete_review path", async () => {
  const created = (await handleTool("create_local_pr", {
    cwd: repo,
    title: "Ready for complete_review",
    body: "No findings.",
    base: "main",
  })) as LocalPr;
  await handleTool("set_status", { cwd: repo, id: created.id, status: "ready" });
  // Seed reviewRequestedSha via add_comment agent Review requested pattern isn't required —
  // complete_review may refuse on drift; allowDrift covers the tool wiring.
  const done = (await handleTool("complete_review", {
    cwd: repo,
    id: created.id,
    body: "LGTM",
    allowDrift: true,
  })) as LocalPr & { headDrift?: boolean };
  assert.equal(done.status, "reviewed");

  const readyOnly = (await handleTool("list_local_prs", {
    cwd: repo,
    status: "ready",
  })) as LocalPr[];
  assert.ok(!readyOnly.some((p) => p.id === created.id));

  const reviewed = (await handleTool("list_local_prs", {
    cwd: repo,
    status: "reviewed",
  })) as LocalPr[];
  assert.ok(reviewed.some((p) => p.id === created.id));
});
