import {
  addLocalPrComment,
  bindRepoGithub,
  createLocalPr,
  findGitRoot,
  getLocalPr,
  getLocalPrDiff,
  getLocalPrNameStatus,
  getRepoGithubBind,
  listGhAccounts,
  listLocalPrs,
  listWorktrees,
  pendingReviewComments,
  setLocalPrStatus,
  updateLocalPr,
  type CommentRole,
  type LocalPr,
  type LocalPrStatus,
} from "@prgenie/core";

function usage(): string {
  return `PR Genie — local pull requests for agent work. GitHub when you say so.

Usage:
  prgenie create [--title <t>] [--body <b>] [--base <ref>] [--head <ref>]
  prgenie list
  prgenie show <id>
  prgenie update <id> [--title <t>] [--body <summary>]
  prgenie diff <id>
  prgenie approve <id>
  prgenie ready <id>
  prgenie request-changes <id> [-m <message>]
  prgenie comment <id> -m <message> [--role human|agent|reviewer] [--author <name>]
  prgenie status <id> <draft|ready|approved|changes_requested>
  prgenie worktrees
  prgenie gh list
  prgenie gh status
  prgenie gh use <login>
  prgenie mcp

Run from any worktree. Packets are stored in the repo's .git/agent-console/.
`;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printPr(pr: LocalPr): void {
  const filesNote = pr.worktreePath ? `\n  worktree: ${pr.worktreePath}` : "\n  worktree: (gone — packet still exists)";
  const summary = pr.body.trim()
    ? `\n  summary: ${pr.body.trim().split("\n")[0].slice(0, 100)}`
    : "\n  summary: (none)";
  process.stdout.write(
    `${pr.id}  ${pr.status.padEnd(18)}  ${pr.headRef} -> ${pr.baseRef}\n  ${pr.title}${filesNote}${summary}\n`,
  );
}

async function cwdRepo(): Promise<string> {
  const cwd = process.cwd();
  const root = await findGitRoot(cwd);
  if (!root) {
    throw new Error("Not inside a git repository.");
  }
  return cwd;
}

export async function run(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  if (args[0] === "mcp") {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return 0;
  }
  if (args[0] === "worktrees") {
    const trees = await listWorktrees(await cwdRepo());
    for (const t of trees) {
      process.stdout.write(`${t.branch ?? "(detached)"}  ${t.path}  ${t.head.slice(0, 8)}\n`);
    }
    return 0;
  }
  if (args[0] === "gh" || args[0] === "github") {
    return runGithub(args.slice(1));
  }
  const sub = args[0];
  const rest = args.slice(1);
  const repo = await cwdRepo();

  if (sub === "create") {
    const pr = await createLocalPr(repo, {
      title: arg(rest, "--title"),
      body: arg(rest, "--body"),
      base: arg(rest, "--base"),
      head: arg(rest, "--head"),
    });
    printPr(pr);
    return 0;
  }
  if (sub === "list") {
    const prs = await listLocalPrs(repo);
    if (prs.length === 0) {
      process.stdout.write("No local PRs.\n");
      return 0;
    }
    for (const pr of prs) printPr(pr);
    return 0;
  }
  const id = rest[0];
  if (!id) {
    process.stderr.write("Missing local PR id.\n");
    return 1;
  }
  if (sub === "show") {
    const pr = await getLocalPr(repo, id);
    process.stdout.write(
      JSON.stringify({ ...pr, pendingComments: pendingReviewComments(pr) }, null, 2) + "\n",
    );
    const files = await getLocalPrNameStatus(repo, pr.id);
    if (files.length) {
      process.stdout.write("\nFiles:\n");
      for (const f of files) process.stdout.write(`  ${f.status}\t${f.path}\n`);
    }
    return 0;
  }
  if (sub === "update") {
    const title = arg(rest, "--title");
    const body = arg(rest, "--body");
    if (title === undefined && body === undefined) {
      process.stderr.write("prgenie update <id> [--title <t>] [--body <summary>]\n");
      return 1;
    }
    printPr(await updateLocalPr(repo, id, { title, body }));
    return 0;
  }
  if (sub === "diff") {
    process.stdout.write(await getLocalPrDiff(repo, id, { stat: flag(rest, "--stat") }));
    if (!flag(rest, "--stat")) process.stdout.write("\n");
    return 0;
  }
  if (sub === "approve") {
    printPr(await setLocalPrStatus(repo, id, "approved"));
    return 0;
  }
  if (sub === "ready") {
    printPr(await setLocalPrStatus(repo, id, "ready"));
    return 0;
  }
  if (sub === "request-changes") {
    const message = arg(rest, "-m") ?? arg(rest, "--message");
    if (message) await addLocalPrComment(repo, id, message, { role: "human" });
    printPr(await setLocalPrStatus(repo, id, "changes_requested"));
    return 0;
  }
  if (sub === "comment") {
    const message = arg(rest, "-m") ?? arg(rest, "--message");
    if (!message) {
      process.stderr.write("prgenie comment <id> -m <message> [--role human|agent|reviewer]\n");
      return 1;
    }
    const role = (arg(rest, "--role") ?? "human") as CommentRole;
    const author = arg(rest, "--author");
    printPr(await addLocalPrComment(repo, id, message, { role, author }));
    return 0;
  }
  if (sub === "status") {
    const status = rest[1] as LocalPrStatus;
    printPr(await setLocalPrStatus(repo, id, status));
    return 0;
  }
  process.stderr.write(usage());
  return 1;
}

async function runGithub(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "status" || sub === "list") {
    const accounts = await listGhAccounts();
    if (accounts.length === 0) {
      process.stdout.write("No GitHub accounts. Run: gh auth login\n");
      return 1;
    }
    const cwd = process.cwd();
    const bind = (await findGitRoot(cwd)) ? await getRepoGithubBind(cwd) : null;
    for (const account of accounts) {
      const flags = [
        account.active ? "active" : "",
        bind && bind.login === account.login && bind.host === account.host
          ? "this-repo"
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      process.stdout.write(
        `${account.host}  ${account.login}${flags ? `  (${flags})` : ""}\n`,
      );
    }
    if (await findGitRoot(cwd) && !bind) {
      process.stdout.write("This repo is unbound. prgenie gh use <login>\n");
    }
    return 0;
  }
  if (sub === "use") {
    const login = args[1];
    if (!login) {
      process.stderr.write("prgenie gh use <login>\n");
      return 1;
    }
    const bind = await bindRepoGithub(await cwdRepo(), login);
    process.stdout.write(`Bound this repo to ${bind.login} on ${bind.host} and switched gh.\n`);
    return 0;
  }
  process.stderr.write(usage());
  return 1;
}

