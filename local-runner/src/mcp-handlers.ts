import type { RunnerEngine } from "./engine.js";
import { normalizeContinueJobArgs, normalizeStartJobArgs } from "./settings-validation.js";

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
        model: {
          type: "string",
          description: "Model for every stage (legacy); a stageModels entry wins for its stage",
        },
        stageModels: {
          type: "object",
          description:
            "Per-stage models; each wins over model, Setup defaults and PRGENIE_RUNNER_MODEL. Fix defaults to auto on cursor-agent.",
          properties: {
            build: { type: "string" },
            review: { type: "string" },
            fix: { type: "string" },
          },
        },
        driver: {
          type: "string",
          description: "Agent driver id (cursor-agent, claude-code, local-model)",
        },
        dryRun: { type: "boolean" },
        ticketUrl: {
          type: "string",
          description: "Linear issue URL (optional; inferred from branch RAD-n when omitted)",
        },
        ticketUrls: {
          type: "array",
          items: { type: "string" },
          description:
            "Tickets the job covers (http(s) URLs, at most 10); ticketUrl, when set, stays primary",
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
  {
    name: "continue_job",
    description:
      "Run additional fix→review round(s) on a terminal job (approved, changes_remaining, stuck, stopped, or failed).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        prompt: { type: "string" },
        promptFile: { type: "string" },
        extraRounds: { type: "number", description: "Default 1" },
        model: { type: "string", description: "Optional fix-stage model override (default auto)" },
      },
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
    case "start_job":
      return engine.startJob(normalizeStartJobArgs(args));
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
    case "continue_job":
      return engine.continueJob({ ...normalizeContinueJobArgs(args) });
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
