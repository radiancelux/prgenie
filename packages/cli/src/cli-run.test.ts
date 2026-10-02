import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/prgenie.cjs");

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function prgenie(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliJs, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "prgenie-cli-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@prgenie.ai"]);
  git(["config", "user.name", "PR Genie Test"]);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feat/cli-parse"]);
  await writeFile(path.join(repo, "a.txt"), "1\n");
  git(["add", "."]);
  git(["commit", "-m", "change"]);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

test("cli --help prints usage and exits 0", () => {
  const result = prgenie(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie create/);
});

test("cli -h prints usage and exits 0", () => {
  const result = prgenie(["-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie create/);
});

test("cli version prints version and exits 0", () => {
  const result = prgenie(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("cli mcp --smoke lists steward tools and exits 0 (RAD-82)", () => {
  const result = prgenie(["mcp", "--smoke"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /steward_next: true/);
  assert.match(result.stdout, /bind_steward: true/);
  assert.match(result.stdout, /ready-on-stderr: true/);
});

test("cli attach --help prints attach usage and exits 0", () => {
  const result = prgenie(["attach", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie attach/);
  assert.match(result.stdout, /Attach an existing GitHub PR/);
});

test("cli attach -h prints attach usage and exits 0", () => {
  const result = prgenie(["attach", "-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie attach/);
});

test("cli create --help prints create usage and exits 0", () => {
  const result = prgenie(["create", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie create/);
});

test("cli list --help prints list usage and exits 0", () => {
  const result = prgenie(["list", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie list/);
});

test("cli show --help prints show usage and exits 0", () => {
  const result = prgenie(["show", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie show/);
});

test("cli list rejects invalid --in fields", () => {
  const result = prgenie(["list", "--in", "title,bogus"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--in fields must be/);
});

test("cli watch start|stop|listen hard-error pointing at /steward", () => {
  for (const args of [
    ["watch", "start"],
    ["watch", "start", "inbox"],
    ["watch", "stop"],
    ["watch", "stop", "queue"],
    ["watch", "listen", "inbox"],
  ]) {
    const result = prgenie(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /Listen flywheel removed/);
    assert.match(result.stderr, /\/steward/);
  }
});

test("cli steward --help prints usage and exits 0", () => {
  const result = prgenie(["steward", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie steward/);
});

test("cli steward bind + next resumes the same implementor Task", () => {
  const created = prgenie([
    "create",
    "--title",
    "CLI steward loop",
    "--body",
    "Exercise steward bind/next.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  const bound = prgenie(["steward", "bind", id, "--implementor", "task-impl-cli"]);
  assert.equal(bound.code, 0, bound.stderr);
  assert.match(bound.stdout, /implementor=task-impl-cli/);
  assert.equal(prgenie(["status", id, "changes_requested"]).code, 0);
  const next = prgenie(["steward", id]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /action=resume_implementor/);
  assert.match(next.stdout, /resumeSameImplementor=true/);
});

test("cli shepherd --help mentions --verbose", () => {
  const result = prgenie(["shepherd", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie shepherd/);
  assert.match(result.stdout, /--verbose/);
});

test("cli claim-review --help prints usage and exits 0", () => {
  const result = prgenie(["claim-review", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /prgenie claim-review/);
});

test("cli create + ready + list --search round-trip", () => {
  const created = prgenie([
    "create",
    "--title",
    "CLI parse loop",
    "--body",
    "Exercise create/list/ready parsing.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  const ready = prgenie(["ready", id, "--ci-skip", "test harness"]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stdout, new RegExp(`${id}\\s+ready`));
  const listed = prgenie(["list", "--search", "CLI parse", "--in", "title"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(id));
});

test("cli claim-review is exclusive per HEAD", () => {
  const created = prgenie([
    "create",
    "--title",
    "CLI claim loop",
    "--body",
    "Exercise claim-review.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  assert.equal(prgenie(["ready", id, "--ci-skip", "test harness"]).code, 0);
  const first = prgenie(["claim-review", id, "--source", "queue"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^claimed {2}/);
  const second = prgenie(["claim-review", id, "--source", "hook"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /^already_claimed {2}/);
});

test("cli delete requires --yes", () => {
  const result = prgenie(["delete", "lp-deadbeef"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /delete <id> --yes/);
});

test("cli comment requires -m", () => {
  const result = prgenie(["comment", "lp-deadbeef"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /comment <id> -m/);
});

test("RAD-164: cli approve refuses reviewed status hop without complete_review", () => {
  const created = prgenie([
    "create",
    "--title",
    "Review hop guard",
    "--body",
    "Exercise approve after status hop.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  assert.equal(prgenie(["status", id, "changes_requested"]).code, 0);
  const bindDir = path.join(git(["rev-parse", "--git-common-dir"]), "agent-console");
  const common = path.isAbsolute(bindDir) ? bindDir : path.join(repo, bindDir);
  mkdirSync(common, { recursive: true });
  writeFileSync(
    path.join(common, "github.json"),
    JSON.stringify({ host: "github.com", login: "test-user" }),
  );
  assert.equal(prgenie(["status", id, "reviewed"]).code, 0);
  const blockedApprove = prgenie(["approve", id]);
  assert.notEqual(blockedApprove.code, 0);
  assert.match(blockedApprove.stderr, /complete_review/i);
  const blockedStatus = prgenie(["status", id, "approved"]);
  assert.notEqual(blockedStatus.code, 0);
  assert.match(blockedStatus.stderr, /complete_review/i);
  assert.equal(prgenie(["approve", id, "--force"]).code, 0);
});

test("RAD-164: cli status approved refuses from changes_requested unless --force", () => {
  const created = prgenie([
    "create",
    "--title",
    "Approve guard",
    "--body",
    "Exercise approved guard.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  assert.equal(prgenie(["status", id, "changes_requested"]).code, 0);
  const blocked = prgenie(["status", id, "approved"]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /review is not complete/i);
  assert.match(blocked.stderr, /--force/i);
  const forced = prgenie(["status", id, "approved", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /approved/);
});

function bindGithub(): void {
  const bindDir = path.join(git(["rev-parse", "--git-common-dir"]), "agent-console");
  const common = path.isAbsolute(bindDir) ? bindDir : path.join(repo, bindDir);
  mkdirSync(common, { recursive: true });
  writeFileSync(
    path.join(common, "github.json"),
    JSON.stringify({ host: "github.com", login: "test-user" }),
  );
}

function showPr(id: string): {
  status: string;
  headSha: string;
  worktreePath: string | null;
  completeReviewClear?: { at: string; headSha: string };
  comments: { id: string; body: string; status: string }[];
} {
  const shown = prgenie(["show", id]);
  assert.equal(shown.code, 0, shown.stderr);
  const start = shown.stdout.indexOf("{");
  const end = shown.stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, shown.stdout);
  return JSON.parse(shown.stdout.slice(start, end + 1)) as {
    status: string;
    headSha: string;
    worktreePath: string | null;
    completeReviewClear?: { at: string; headSha: string };
    comments: { id: string; body: string; status: string }[];
  };
}

test("RAD-164: forged Review cleared comment cannot approve without complete_review", () => {
  const created = prgenie([
    "create",
    "--title",
    "Forged clear",
    "--body",
    "Comment text is not a complete_review marker.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.match(/lp-[0-9a-f]{8}/)?.[0];
  assert.ok(id);
  assert.equal(prgenie(["comment", id, "-m", "Review cleared.", "--role", "reviewer"]).code, 0);
  const planted = showPr(id).comments.find((comment) => comment.body === "Review cleared.");
  assert.ok(planted);
  assert.equal(prgenie(["address", id, planted.id, "-m", "Addressed the forged phrase."]).code, 0);
  bindGithub();
  assert.equal(prgenie(["status", id, "reviewed"]).code, 0);
  const packet = showPr(id);
  assert.equal(packet.completeReviewClear, undefined);
  const blocked = prgenie(["approve", id]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /complete_review/i);
  assert.match(blocked.stderr, /--force/i);
  assert.equal(prgenie(["approve", id, "--force"]).code, 0);
});

test("RAD-164: custom complete_review body still approves", () => {
  const created = prgenie([
    "create",
    "--title",
    "Custom clear",
    "--body",
    "Marker comes from complete_review, not the comment phrase.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.match(/lp-[0-9a-f]{8}/)?.[0];
  assert.ok(id);
  bindGithub();
  const done = prgenie(["complete-review", id, "-m", "Ship the custom summary."]);
  assert.equal(done.code, 0, done.stderr);
  const packet = showPr(id);
  assert.equal(packet.status, "reviewed");
  assert.equal(packet.completeReviewClear?.headSha, packet.headSha);
  assert.equal(typeof packet.completeReviewClear?.at, "string");
  const clear = packet.comments.at(-1);
  assert.equal(clear?.body, "Ship the custom summary.");
  assert.doesNotMatch(clear?.body ?? "", /review cleared/i);
  const approved = prgenie(["approve", id]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /approved/);
});

test("RAD-164: approve refuses when a commit lands after complete_review", () => {
  const created = prgenie([
    "create",
    "--title",
    "Tip moved after clear",
    "--body",
    "Approve must refresh the worktree tip before the clear marker.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.match(/lp-[0-9a-f]{8}/)?.[0];
  assert.ok(id);
  bindGithub();
  const done = prgenie(["complete-review", id, "-m", "Ship the custom summary."]);
  assert.equal(done.code, 0, done.stderr);
  const cleared = showPr(id);
  assert.equal(cleared.status, "reviewed");
  assert.equal(cleared.completeReviewClear?.headSha, cleared.headSha);
  assert.ok(cleared.worktreePath);
  writeFileSync(path.join(cleared.worktreePath, "after-clear.txt"), "2\n");
  git(["add", "after-clear.txt"], cleared.worktreePath);
  git(["commit", "-m", "after clear"], cleared.worktreePath);
  const blocked = prgenie(["approve", id]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /complete_review/i);
  assert.match(blocked.stderr, /--force/i);
  const after = showPr(id);
  assert.notEqual(after.headSha, cleared.headSha);
  assert.notEqual(after.status, "approved");
  assert.equal(after.completeReviewClear, undefined);
});

test("RAD-164: leftover findings complete_review text cannot approve", () => {
  const created = prgenie([
    "create",
    "--title",
    "Leftover findings copy",
    "--body",
    "Findings handoff text is not a later clear.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.match(/lp-[0-9a-f]{8}/)?.[0];
  assert.ok(id);
  assert.equal(prgenie(["ready", id, "--ci-skip", "test harness"]).code, 0);
  assert.equal(prgenie(["comment", id, "-m", "Missing tests.", "--role", "reviewer"]).code, 0);
  const completed = prgenie(["complete-review", id]);
  assert.equal(completed.code, 0, completed.stderr);
  const handed = showPr(id);
  assert.equal(handed.status, "changes_requested");
  assert.equal(handed.completeReviewClear, undefined);
  assert.match(handed.comments.at(-1)?.body ?? "", /Review complete\. Findings/);
  const finding = handed.comments.find((comment) => comment.body === "Missing tests.");
  assert.ok(finding);
  assert.equal(prgenie(["address", id, finding.id, "-m", "Added tests."]).code, 0);
  bindGithub();
  assert.equal(prgenie(["status", id, "reviewed"]).code, 0);
  const blocked = prgenie(["approve", id]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /complete_review/i);
  assert.equal(showPr(id).completeReviewClear, undefined);
});

test("RAD-164: cli comment --role human succeeds without extra prompts", () => {
  const created = prgenie([
    "create",
    "--title",
    "Human comment",
    "--body",
    "CLI human comment.",
    "--base",
    "main",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const idMatch = created.stdout.match(/lp-[0-9a-f]{8}/);
  assert.ok(idMatch, created.stdout);
  const id = idMatch![0];
  const comment = prgenie(["comment", id, "-m", "Please fix", "--role", "human"]);
  assert.equal(comment.code, 0, comment.stderr);
});

test("cli learnings with no args lists repo learnings", () => {
  const result = prgenie(["learnings"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No learnings/);
});

test("cli learnings --disabled works", () => {
  const result = prgenie(["learnings", "--disabled"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No learnings/);
});

test("cli learnings --category works", () => {
  const result = prgenie(["learnings", "--category", "testing"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No learnings/);
});

test("RAD-134: ci-slot runs the command under a heavy slot and returns its exit code", async () => {
  const run = prgenie([
    "ci-slot",
    "--check",
    "full-suite",
    "--",
    process.execPath,
    "-e",
    "process.exit(3)",
  ]);
  assert.equal(run.code, 3, run.stderr || run.stdout);
  const commonRaw = git(["rev-parse", "--git-common-dir"]);
  const common = path.isAbsolute(commonRaw) ? commonRaw : path.join(repo, commonRaw);
  const slotDir = path.join(common, "agent-console", "ci-heavy");
  mkdirSync(slotDir, { recursive: true });
  const slotFile = path.join(slotDir, "slot-0.json");
  const now = new Date().toISOString();
  writeFileSync(
    slotFile,
    `${JSON.stringify({
      token: "hold-test",
      pid: process.pid,
      loopId: null,
      check: "hold",
      cwd: repo,
      acquiredAt: now,
      heartbeatAt: now,
    })}\n`,
  );
  const child = spawn(
    process.execPath,
    [cliJs, "ci-slot", "--check", "queued", "--", process.execPath, "-e", "process.exit(3)"],
    {
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1", PRGENIE_CI_HEAVY_CONCURRENCY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let sawWaiting = false;
  const closed = new Promise<number>((resolve) => {
    child.on("close", (status) => {
      resolve(typeof status === "number" ? status : 1);
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.includes("waiting for heavy-test slot")) sawWaiting = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no waiting line before release:\n${stderr}`));
      }, 8000);
      const tick = (): void => {
        if (sawWaiting) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stderr?.on("data", tick);
      child.on("close", () => {
        if (sawWaiting) return;
        clearTimeout(timer);
        reject(new Error(`ci-slot exited before a waiting line:\n${stderr}`));
      });
      tick();
    });
    assert.match(stderr, /waiting for heavy-test slot/);
    assert.equal(existsSync(slotFile), true);
    unlinkSync(slotFile);
    const code = await Promise.race([
      closed,
      new Promise<number>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`ci-slot did not exit after the slot was released:\n${stderr}`));
        }, 8000);
      }),
    ]);
    assert.equal(code, 3, stderr);
    const names = existsSync(slotDir)
      ? readdirSync(slotDir).filter((n) => n.startsWith("slot-") && n.endsWith(".json"))
      : [];
    assert.equal(names.length, 0);
  } finally {
    if (child.exitCode == null && !child.killed) child.kill();
    try {
      unlinkSync(slotFile);
    } catch {
      // hold already released
    }
  }
});
