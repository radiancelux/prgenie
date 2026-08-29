import {
  addLocalPrComment,
  addressLocalPrComment,
  addressedReviewComments,
  bindRepoGithub,
  commentThreads,
  completeLocalPrReview,
  createLocalPr,
  exportLocalPr,
  ensureWorktreeForLoop,
  findGitRoot,
  getLocalPr,
  getLocalPrDiff,
  getLocalPrNameStatus,
  getRepoGithubBind,
  getRepoWatch,
  haltWatch,
  listGhAccounts,
  listLocalPrs,
  listWorktrees,
  pendingReviewComments,
  resolveLocalPrComment,
  resumeWatch,
  setLocalPrStatus,
  updateLocalPr,
  type CommentRole,
  type LocalPr,
  type LocalPrStatus,
} from "@prgenie/core";

type Json = Record<string, unknown>;

function writeMessage(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function withCommentViews(pr: LocalPr) {
  return {
    ...pr,
    pendingComments: pendingReviewComments(pr),
    addressedComments: addressedReviewComments(pr),
    threads: commentThreads(pr.comments),
  };
}

async function repoCwd(): Promise<string> {
  const cwd = process.cwd();
  const root = await findGitRoot(cwd);
  if (!root) throw new Error("Not inside a git repository.");
  return cwd;
}

async function handleTool(name: string, args: Json): Promise<unknown> {
  if (name === "gh_list" || name === "github_list") {
    return listGhAccounts();
  }
  const cwd = typeof args.cwd === "string" ? args.cwd : await repoCwd();
  switch (name) {
    case "gh_status":
    case "github_status":
      return {
        accounts: await listGhAccounts(),
        bound: await getRepoGithubBind(cwd),
      };
    case "gh_use":
    case "github_use":
      return bindRepoGithub(cwd, String(args.login ?? ""));
    case "list_worktrees":
      return listWorktrees(cwd);
    case "list_local_prs": {
      const prs = (await listLocalPrs(cwd)).map(withCommentViews);
      const status = typeof args.status === "string" ? args.status : "";
      const inbox = args.inbox === true;
      return prs.filter((pr) => {
        if (status && pr.status !== status) return false;
        if (inbox && pr.pendingComments.length === 0) return false;
        return true;
      });
    }
    case "create_local_pr":
      return createLocalPr(cwd, {
        title: typeof args.title === "string" ? args.title : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
        base: typeof args.base === "string" ? args.base : undefined,
        head: typeof args.head === "string" ? args.head : undefined,
      });
    case "update_local_pr":
      return updateLocalPr(cwd, String(args.id ?? ""), {
        title: typeof args.title === "string" ? args.title : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
      });
    case "get_local_pr": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
      return withCommentViews(pr);
    }
    case "set_status":
      return setLocalPrStatus(cwd, String(args.id ?? ""), args.status as LocalPrStatus);
    case "add_comment": {
      const role = typeof args.role === "string" ? (args.role as CommentRole) : undefined;
      const author = typeof args.author === "string" ? args.author : undefined;
      return addLocalPrComment(cwd, String(args.id ?? ""), String(args.body ?? ""), {
        role,
        author,
        path: typeof args.path === "string" ? args.path : undefined,
        line: typeof args.line === "number" ? args.line : undefined,
        side: args.side === "left" || args.side === "right" ? args.side : undefined,
        replyTo: typeof args.replyTo === "string" ? args.replyTo : undefined,
      });
    }
    case "address_comment":
      return addressLocalPrComment(
        cwd,
        String(args.id ?? ""),
        String(args.commentId ?? ""),
        String(args.body ?? ""),
        { author: typeof args.author === "string" ? args.author : undefined },
      );
    case "resolve_comment":
      return resolveLocalPrComment(
        cwd,
        String(args.id ?? ""),
        String(args.commentId ?? ""),
        String(args.body ?? ""),
        {
          author: typeof args.author === "string" ? args.author : undefined,
          role: args.role === "human" ? "human" : "reviewer",
        },
      );
    case "complete_review":
      return completeLocalPrReview(cwd, String(args.id ?? ""), {
        author: typeof args.author === "string" ? args.author : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
      });
    case "get_diff":
      return {
        files: await getLocalPrNameStatus(cwd, String(args.id ?? "")),
        diff: await getLocalPrDiff(cwd, String(args.id ?? ""), { maxBytes: 80_000 }),
      };
    case "watch_status":
      return getRepoWatch(cwd);
    case "watch_stop":
      return haltWatch(cwd, "stop");
    case "watch_start":
      return resumeWatch(cwd);
    case "ensure_worktree": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
      const dest = await ensureWorktreeForLoop(cwd, pr);
      return { ...pr, worktreePath: dest };
    }
    case "export_local_pr":
      return exportLocalPr(cwd, String(args.id ?? ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const tools = [
  {
    name: "list_worktrees",
    description: "List git worktrees. PR Genie also ensures one worktree per loop.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "ensure_worktree",
    description:
      "Ensure this loop has a git worktree and return its path. Creates a sibling <repo>.loops/<id> checkout when the branch is not already checked out.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "list_local_prs",
    description:
      "List unpublished local pull requests. status=ready is the reviewer queue. status=reviewed is waiting on the human. inbox=true is loops with open pendingComments for the implementor.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "ready", "changes_requested", "reviewed", "approved"],
        },
        inbox: {
          type: "boolean",
          description: "Only loops with pending human/reviewer comments.",
        },
      },
    },
  },
  {
    name: "create_local_pr",
    description:
      "Create a local PR (unpublished review loop) from the current branch or a named head. Always set body to a reviewer summary (why, what changed, how to test). Do not git push or gh pr create.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: {
          type: "string",
          description: "Loop summary for reviewers: why, what changed, how to test.",
        },
        base: { type: "string" },
        head: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "update_local_pr",
    description:
      "Update a local PR title and/or body (the reviewer summary). Use this to fill or refresh the summary before set_status ready.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "get_local_pr",
    description:
      "Show one local PR by id (prefix allowed). body is the author summary for reviewers. pendingComments are open findings for the implementor. addressedComments are waiting for the reviewer to resolve. threads nest agent replies under those findings.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "set_status",
    description: "Set local PR status: draft, ready, changes_requested, reviewed, approved. reviewed means the automated reviewer signed off and the human should look.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["draft", "ready", "changes_requested", "reviewed", "approved"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "add_comment",
    description:
      "Add a local review comment. role=human or role=reviewer is an open finding (status=open) and sets the loop to changes_requested. role=agent is a reply nested under the last finding unless replyTo is set; Review requested stays a root. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "body"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        role: { type: "string", enum: ["human", "agent", "reviewer"] },
        author: { type: "string" },
        path: { type: "string" },
        line: { type: "number" },
        side: { type: "string", enum: ["left", "right"] },
        replyTo: { type: "string", description: "Nest this comment under an existing comment id." },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "address_comment",
    description:
      "Implementor: mark an open finding addressed and attach a reply under it. Does not set ready. After the inbox is empty, set_status ready and add_comment role=agent Review requested. The reviewer resolves addressed comments. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId", "body"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "resolve_comment",
    description:
      "Reviewer or human: mark an addressed finding resolved and attach a reply under it. If nothing open or addressed remains, the loop becomes reviewed (ready for human review). Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId", "body"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        role: { type: "string", enum: ["reviewer", "human"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "complete_review",
    description:
      "Reviewer: no new findings. Resolves remaining addressed comments and sets the loop to reviewed so the human can review. Fails if open findings remain. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "get_diff",
    description: "Return name-status and diff for a local PR.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "watch_status",
    description:
      "Show whether the developer halted the review listen loops (stop or export).",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "watch_stop",
    description:
      "Developer command: halt reviewer and implementor listen loops. Does not push or open GitHub.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "watch_start",
    description: "Resume listen loops after watch_stop.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "export_local_pr",
    description:
      "Developer command: halt listen loops, approve the loop, git push, and open a GitHub PR at origin. Only when the developer explicitly asks to export.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "gh_list",
    description: "List GitHub CLI accounts (gh auth status). Does not switch.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gh_status",
    description: "Show GitHub CLI accounts and which login this repo is bound to.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "gh_use",
    description:
      "Bind this git repository to a gh login (writes .git/agent-console/github.json) and run gh auth switch. Does not bind other repos.",
    inputSchema: {
      type: "object",
      required: ["login"],
      properties: { login: { type: "string" }, cwd: { type: "string" } },
    },
  },
];

async function onRequest(msg: Json): Promise<void> {
  const id = msg.id;
  const method = msg.method as string;
  const params = (msg.params as Json) ?? {};
  try {
    if (method === "initialize") {
      const requested =
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      ok(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: "prgenie", version: "0.1.0" },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      return;
    }
    if (method === "notifications/cancelled") {
      return;
    }
    if (method === "tools/list") {
      ok(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments as Json) ?? {};
      const result = await handleTool(name, args);
      ok(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
      return;
    }
    if (method === "ping") {
      ok(id, {});
      return;
    }
    if (id === undefined) return;
    fail(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (id === undefined) return;
    fail(id, -32000, err instanceof Error ? err.message : String(err));
  }
}

export async function startMcp(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    void drain();
  });

  async function drain(): Promise<void> {
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line || /^Content-Length:/i.test(line)) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (msg.method) await onRequest(msg);
    }
  }
}
