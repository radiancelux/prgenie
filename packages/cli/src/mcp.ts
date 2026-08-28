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
  setLocalPrStatus,
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
    case "list_local_prs":
      return listLocalPrs(cwd);
    case "create_local_pr":
      return createLocalPr(cwd, {
        title: typeof args.title === "string" ? args.title : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
        base: typeof args.base === "string" ? args.base : undefined,
        head: typeof args.head === "string" ? args.head : undefined,
      });
    case "get_local_pr":
      return getLocalPr(cwd, String(args.id ?? ""));
    case "set_status":
      return setLocalPrStatus(cwd, String(args.id ?? ""), args.status as LocalPrStatus);
    case "add_comment":
      return addLocalPrComment(cwd, String(args.id ?? ""), String(args.body ?? ""));
    case "get_diff":
      return {
        files: await getLocalPrNameStatus(cwd, String(args.id ?? "")),
        diff: await getLocalPrDiff(cwd, String(args.id ?? ""), { maxBytes: 80_000 }),
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const tools = [
  {
    name: "list_worktrees",
    description: "Discover existing git worktrees. Does not create or delete them.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "list_local_prs",
    description: "List unpublished local pull requests in this repository.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
  {
    name: "create_local_pr",
    description:
      "Create a local PR (unpublished review packet) from the current branch or a named head. Do not git push or gh pr create.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "get_local_pr",
    description: "Show one local PR by id (prefix allowed).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, cwd: { type: "string" } },
    },
  },
  {
    name: "set_status",
    description: "Set local PR status: draft, ready, approved, changes_requested.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["draft", "ready", "approved", "changes_requested"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "add_comment",
    description: "Add a local review comment. Moves ready/approved packets back to changes_requested.",
    inputSchema: {
      type: "object",
      required: ["id", "body"],
      properties: {
        id: { type: "string" },
        body: { type: "string" },
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
