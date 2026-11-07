import { isDocsTemplateId } from "./docs-prompts.js";
import type { RunnerEngine } from "./engine.js";
import type { StartJobArgs } from "./types.js";

type Json = Record<string, unknown>;

export const RUNNER_MCP_TOOLS = [
  {
    name: "start_job",
    description: "Start a local CLI runner job (implement → PR → review → fix loop).",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        remote: { type: "string" },
        branch: { type: "string" },
        promptFile: { type: "string" },
        reviewPromptFile: { type: "string" },
        fixPromptFile: { type: "string" },
        maxRounds: { type: "number" },
        model: { type: "string" },
        driver: {
          type: "string",
          description: "Agent driver id (cursor-agent, claude-code, local-model)",
        },
        dryRun: { type: "boolean" },
        ticketUrl: {
          type: "string",
          description: "Linear issue URL (optional; inferred from branch RAD-n when omitted)",
        },
        linearIssue: {
          type: "string",
          description: "Linear issue id e.g. (optional; builds ticketUrl when set alone)",
        },
        jobType: {
          type: "string",
          enum: ["code", "docs"],
          description: "code (default) or docs for business/policy Markdown PRs",
        },
        profile: {
          type: "string",
          enum: ["code", "docs"],
          description: "Alias for jobType",
        },
        docsTemplate: {
          type: "string",
          enum: ["marketing", "policy", "research"],
          description: "Built-in docs implementor template (docs jobs)",
        },
        title: {
          type: "string",
          description:
            "Dashboard agent row label (optional; derived from Linear slug, prompt # heading, or branch)",
        },
      },
      required: ["branch"],
    },
  },
  {
    name: "list_jobs",
    description:
      "List runner jobs (newest first). Merged PRs drop off the list after about one hour.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: {
          type: "boolean",
          description: "Also list archived (removed) jobs; they have archivedAt set",
        },
      },
    },
  },
  {
    name: "get_job",
    description: "Get job status and log tail.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "steer_job",
    description: "Queue a follow-up prompt for the next agent step (or after current step).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, prompt: { type: "string" } },
      required: ["id", "prompt"],
    },
  },
  {
    name: "stop_job",
    description: "Request job stop (kills in-flight cursor-agent).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "archive_job",
    description:
      "Remove a finished job from the dashboard (moves it under archived/). Rejected while the job is running. Removes the worktree only when clean; otherwise keeps it and returns a warning.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "restore_job",
    description: "Restore an archived job back onto the dashboard.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] as const;

export async function handleRunnerTool(
  engine: RunnerEngine,
  name: string,
  args: Json,
): Promise<unknown> {
  switch (name) {
    case "start_job": {
      const input: StartJobArgs = {
        repoPath: typeof args.repoPath === "string" ? args.repoPath : undefined,
        remote: typeof args.remote === "string" ? args.remote : undefined,
        branch: String(args.branch ?? ""),
        promptFile: typeof args.promptFile === "string" ? args.promptFile : undefined,
        reviewPromptFile:
          typeof args.reviewPromptFile === "string" ? args.reviewPromptFile : undefined,
        fixPromptFile: typeof args.fixPromptFile === "string" ? args.fixPromptFile : undefined,
        maxRounds: typeof args.maxRounds === "number" ? args.maxRounds : undefined,
        model: typeof args.model === "string" ? args.model : undefined,
        driver: typeof args.driver === "string" ? args.driver : undefined,
        dryRun: typeof args.dryRun === "boolean" ? args.dryRun : undefined,
        ticketUrl: typeof args.ticketUrl === "string" ? args.ticketUrl : undefined,
        linearIssue: typeof args.linearIssue === "string" ? args.linearIssue : undefined,
        docsTemplate:
          typeof args.docsTemplate === "string" && isDocsTemplateId(args.docsTemplate)
            ? args.docsTemplate
            : undefined,
        jobType:
          args.jobType === "docs" || args.jobType === "code"
            ? args.jobType
            : args.profile === "docs" || args.profile === "code"
              ? args.profile
              : undefined,
        profile: args.profile === "docs" || args.profile === "code" ? args.profile : undefined,
        title: typeof args.title === "string" ? args.title : undefined,
      };
      if (!input.branch) {
        throw new Error("branch is required");
      }
      const isDocs =
        input.jobType === "docs" ||
        input.profile === "docs" ||
        args.profile === "docs" ||
        args.jobType === "docs";
      if (!isDocs && !input.promptFile?.trim()) {
        throw new Error("promptFile is required for code jobs");
      }
      if (isDocs && !input.promptFile?.trim() && !input.docsTemplate) {
        throw new Error("docs jobs need docsTemplate or promptFile");
      }
      return engine.startJob(input);
    }
    case "list_jobs":
      return engine.list({ includeArchived: args.includeArchived === true });
    case "get_job": {
      const id = String(args.id ?? "");
      const job = await engine.get(id);
      if (!job) throw new Error(`job not found: ${id}`);
      return job;
    }
    case "steer_job": {
      const id = String(args.id ?? "");
      const prompt = String(args.prompt ?? "");
      const job = await engine.steer(id, prompt);
      if (!job) throw new Error(`job not found: ${id}`);
      return job;
    }
    case "stop_job": {
      const id = String(args.id ?? "");
      const job = await engine.stop(id);
      if (!job) throw new Error(`job not found: ${id}`);
      return job;
    }
    case "archive_job": {
      const id = String(args.id ?? "");
      const result = await engine.archive(id);
      if (!result.ok) throw new Error(`${result.error}: ${id}`);
      return result;
    }
    case "restore_job": {
      const id = String(args.id ?? "");
      const result = await engine.restore(id);
      if (!result.ok) throw new Error(`${result.error}: ${id}`);
      return { ok: true, id: result.id, stage: result.job.stage };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleMcpJsonRpc(
  engine: RunnerEngine,
  msg: { id?: unknown; method?: string; params?: Json },
): Promise<{ id?: unknown; result?: unknown; error?: { code: number; message: string } } | null> {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "prgenie-local-runner", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "ping") {
    return null;
  }
  if (method === "tools/list") {
    return { id, result: { tools: RUNNER_MCP_TOOLS } };
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const toolArgs = (params?.arguments ?? {}) as Json;
    try {
      const structured = await handleRunnerTool(engine, name, toolArgs);
      return {
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        },
      };
    } catch (err) {
      return {
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  if (id !== undefined) {
    return { id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return null;
}
