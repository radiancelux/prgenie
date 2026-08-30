import {
  addLocalPrComment,
  addressLocalPrComment,
  addressedReviewComments,
  archiveLoopsMergedOnGithub,
  bindRepoGithub,
  commentThreads,
  completeLocalPrReview,
  createLocalPr,
  deleteLocalPr,
  deleteLocalPrComment,
  editLocalPrComment,
  exportLocalPr,
  ensureWorktreeForLoop,
  findGitRoot,
  findLocalPrForCurrentWorktree,
  getLocalPr,
  getLocalPrDiff,
  getLocalPrNameStatus,
  getRepoGithubBind,
  getRepoWatch,
  haltWatch,
  haltWatchRole,
  listGhAccounts,
  listLocalPrs,
  listWorktrees,
  pendingReviewComments,
  isArchivedPr,
  reopenLocalPr,
  resolveLocalPrComment,
  resumeWatch,
  resumeWatchRole,
  setLocalPrStatus,
  updateLocalPr,
  type CommentRole,
  type LocalPr,
  type LocalPrStatus,
} from "@prgenie/core";

import { encodeMcpFrame, takeMcpMessages } from "./mcp-stdio.js";

type Json = Record<string, unknown>;

function writeMessage(msg: Json): void {
  process.stdout.write(encodeMcpFrame(msg));
}

function ok(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params?: Json): void {
  writeMessage(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
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
      await archiveLoopsMergedOnGithub(cwd).catch(() => []);
      const prs = (await listLocalPrs(cwd)).map(withCommentViews);
      const status = typeof args.status === "string" ? args.status : "";
      const inbox = args.inbox === true;
      const all = args.all === true;
      if (inbox) {
        const mine = await findLocalPrForCurrentWorktree(cwd);
        if (
          !mine ||
          mine.status !== "changes_requested" ||
          pendingReviewComments(mine).length === 0
        ) {
          return [];
        }
        return [withCommentViews(mine)];
      }
      return prs.filter((pr) => {
        if (status && pr.status !== status) return false;
        if (!status && !all && isArchivedPr(pr)) return false;
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
    case "edit_comment":
      return editLocalPrComment(
        cwd,
        String(args.id ?? ""),
        String(args.commentId ?? ""),
        String(args.body ?? ""),
      );
    case "delete_comment":
      return deleteLocalPrComment(cwd, String(args.id ?? ""), String(args.commentId ?? ""));
    case "complete_review":
      return completeLocalPrReview(cwd, String(args.id ?? ""), {
        author: typeof args.author === "string" ? args.author : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
        allowDrift: args.allowDrift === true,
      });
    case "get_diff": {
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p): p is string => typeof p === "string")
        : undefined;
      return {
        files: await getLocalPrNameStatus(cwd, String(args.id ?? "")),
        diff: await getLocalPrDiff(cwd, String(args.id ?? ""), {
          maxBytes: 80_000,
          stat: args.stat === true,
          paths,
        }),
        truncatedHint:
          "If diff ends with truncated, call get_diff with stat=true then again with paths for individual files.",
      };
    }
    case "delete_local_pr":
      return deleteLocalPr(cwd, String(args.id ?? ""));
    case "reopen_local_pr":
      return reopenLocalPr(cwd, String(args.id ?? ""));
    case "watch_status":
      return getRepoWatch(cwd);
    case "watch_stop": {
      const role = args.role === "inbox" || args.role === "queue" ? args.role : undefined;
      return role ? haltWatchRole(cwd, role, "stop") : haltWatch(cwd, "stop");
    }
    case "watch_start": {
      const role = args.role === "inbox" || args.role === "queue" ? args.role : undefined;
      return role ? resumeWatchRole(cwd, role) : resumeWatch(cwd);
    }
    case "ensure_worktree": {
      const pr = await getLocalPr(cwd, String(args.id ?? ""));
    const dest = await ensureWorktreeForLoop(cwd, pr, {
      staleLoopIds: (await listLocalPrs(cwd))
        .filter((p) => p.id !== pr.id && isArchivedPr(p))
        .map((p) => p.id),
      liveLoopIds: (await listLocalPrs(cwd))
        .filter((p) => !isArchivedPr(p))
        .map((p) => p.id),
    });
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
      "List unpublished local pull requests. Approved (exported) loops are archived and hidden unless all=true or status=approved. status=ready is the reviewer queue (comments may still be accumulating). status=reviewed is waiting on the human. inbox=true is only this worktree's loop when it is changes_requested with open pendingComments.",
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
          description: "Only this worktree's loop, and only if it is changes_requested with open pendingComments.",
        },
        all: {
          type: "boolean",
          description: "Include archived (approved/exported) loops. Hidden by default.",
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
      "Show one local PR by id (prefix allowed). body is the author summary for reviewers. pendingComments are open findings. The implementor inbox only acts on them when status is changes_requested. addressedComments are waiting for the reviewer to resolve. threads nest agent replies under those findings.",
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
      "Add a local review comment. role=human is an open finding and sets the loop to changes_requested unless archived. role=reviewer files a finding while status stays ready until complete_review — except on a reviewed loop, where a new reviewer finding flips to changes_requested so the implementor is woken. role=agent is a reply nested under the last finding unless replyTo is set; Review requested stays a root. Archived loops stay archived. Do not git push.",
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
      "Implementor: mark an open finding addressed and attach a reply under it. Addressing the last open finding sets the loop to ready, refreshes HEAD, and posts Review requested so the reviewer queue can pick it up. The reviewer resolves addressed comments. Do not git push.",
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
    name: "edit_comment",
    description:
      "Edit the body of an open finding (human or reviewer). Does not change status. Archived loops and non-open findings are refused. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId", "body"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        body: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "delete_comment",
    description:
      "Delete an open finding and replies under it. Addressed/resolved threads are refused. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id", "commentId"],
      properties: {
        id: { type: "string" },
        commentId: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "complete_review",
    description:
      "Reviewer: end of review. Always call this when finished. Open findings set the loop to changes_requested for the implementor. No open findings sets reviewed for the human. Resolves remaining addressed comments. Refuses when HEAD moved after Review requested unless allowDrift=true — re-diff and file findings first. Archived loops stay archived. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        author: { type: "string" },
        allowDrift: {
          type: "boolean",
          description: "Finalize even when headSha differs from reviewRequestedSha. Default false.",
        },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "get_diff",
    description:
      "Return name-status and diff for a local PR. Use stat=true for a summary first; use paths to fetch individual files when the full diff would truncate at 80KB.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        cwd: { type: "string" },
        stat: {
          type: "boolean",
          description: "Return git diff --stat instead of the full patch.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Limit the diff to these paths (after --).",
        },
      },
    },
  },
  {
    name: "delete_local_pr",
    description:
      "Permanently delete a local PR packet, its refs, and any sibling .loops worktree. Prefer archive via export for shipped work. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "reopen_local_pr",
    description:
      "Reopen an archived (approved) loop as changes_requested and recreate its worktree. Do not git push.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "watch_status",
    description:
      "Show listen-loop halt state. inbox is the implementor watch; queue is the reviewer watch. halted is true only when both are halted. Export halt sets both.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "watch_stop",
    description:
      "Halt listen loops. Omit role to halt both (same as /stop-watch). role=inbox is /stop-loop. role=queue is /stop-review. Does not push or open GitHub.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        role: {
          type: "string",
          enum: ["inbox", "queue"],
          description: "inbox = implementor listen, queue = reviewer listen. Omit to halt both.",
        },
      },
    },
  },
  {
    name: "watch_start",
    description:
      "Resume listen loops. Omit role to resume both. role=inbox is /watch-review-inbox re-arm. role=queue is /watch-ready-prs re-arm. Do not use from a review-inbox/review-queue tick. Creating a new loop also resumes export-halted lanes after that id is archived.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        role: {
          type: "string",
          enum: ["inbox", "queue"],
          description: "inbox = implementor listen, queue = reviewer listen. Omit to resume both.",
        },
      },
    },
  },
  {
    name: "export_local_pr",
    description:
      "Developer command: halt listen loops, git push, open a GitHub PR, archive the loop, check the main workspace off the loop branch, and remove the extra .loops worktree. Only when the developer explicitly asks to export.",
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
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "prgenie", version: "0.1.1" },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      notify("notifications/tools/list_changed");
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
  let buffer = Buffer.alloc(0);
  let draining = false;
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    buffer = Buffer.concat([buffer, bytes]);
    void drain();
  });

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const taken = takeMcpMessages(buffer);
        buffer = Buffer.from(taken.rest);
        if (taken.messages.length === 0) break;
        for (const raw of taken.messages) {
          const msg = raw as Json;
          if (msg && typeof msg === "object" && msg.method) await onRequest(msg);
        }
      }
    } finally {
      draining = false;
    }
  }
}
