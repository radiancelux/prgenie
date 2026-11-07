import type { RunnerEngine } from "./engine.js";
import { loadSettings, saveSettings, toPublicSettings } from "./settings.js";
import { normalizeStartJobArgs, parseSettingsPatch } from "./settings-validation.js";

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
  {
    name: "settings",
    description:
      "Read runner settings (no arguments) or patch defaults/drivers/watchdog (same fields as PATCH /api/settings).",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "object", description: "Optional nested patch object" },
        expectedRevision: { type: "number" },
      },
    },
  },
] as const;

export const RUNNER_MCP_TOOL_NAMES = RUNNER_MCP_TOOLS.map((t) => t.name);

type ToolHandler = (engine: RunnerEngine, args: Json) => Promise<unknown>;

const RUNNER_TOOL_HANDLERS: Record<string, ToolHandler> = {
  start_job: (engine, args) => engine.startJob(normalizeStartJobArgs(args)),
  list_jobs: (engine, args) => engine.list({ includeArchived: args.includeArchived === true }),
  get_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const job = await engine.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  },
  steer_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const prompt = String(args.prompt ?? "");
    const job = await engine.steer(id, prompt);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  },
  stop_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const job = await engine.stop(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  },
  archive_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const result = await engine.archive(id);
    if (!result.ok) throw new Error(`${result.error}: ${id}`);
    return result;
  },
  restore_job: async (engine, args) => {
    const id = String(args.id ?? "");
    const result = await engine.restore(id);
    if (!result.ok) throw new Error(`${result.error}: ${id}`);
    return { ok: true, id: result.id, stage: result.job.stage };
  },
  settings: async (engine, args) => {
    const dataDir = engine.config.dataDir;
    const hasPatch =
      args.patch !== undefined && args.patch !== null && typeof args.patch === "object";
    const topLevelKeys = Object.keys(args).filter((k) => k !== "patch");
    if (!hasPatch && topLevelKeys.length === 0) {
      return toPublicSettings(engine.config, await loadSettings(dataDir));
    }
    const patch = parseSettingsPatch((hasPatch ? (args.patch as Json) : args) as Json);
    const saved = await saveSettings(dataDir, patch);
    return toPublicSettings(engine.config, saved);
  },
};

export async function handleRunnerTool(
  engine: RunnerEngine,
  name: string,
  args: Json,
): Promise<unknown> {
  const handler = RUNNER_TOOL_HANDLERS[name];
  if (!handler) throw new Error(`unknown tool: ${name}`);
  return handler(engine, args);
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
        serverInfo: { name: "prgenie", version: "0.1.2" },
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
